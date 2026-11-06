/**
 * Escaping every key, or none (#183), through the entity, the aggregate and the stream: what each
 * setting stores against what the published 1.36.0 stored (`fixtures/rows-1.36.0.json`), that each
 * finds what it wrote, that `rekey` brings over what the published 1.37.0 and 1.38.0 stored
 * (`fixtures/rows-1.37.0.json`, `rows-1.38.0.json`), and the canonical GSI shapes with values a key
 * escapes. These scenarios run on a recording table and on DynamoDB Local, through a {@link Harness}.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Schema } from "effect"
import { expect } from "vitest"
import * as Aggregate from "../../src/Aggregate.js"
import { DynamoClient } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as EventStore from "../../src/EventStore.js"
import * as Table from "../../src/Table.js"
import {
  CASINGS,
  type Casing,
  CHANGED,
  keysOf,
  type Library,
  makeWorld,
  type Numbers,
  PADDED,
  PLAIN,
  SPELLED,
  type Values,
  writeEveryKey,
} from "./KeyRows.js"

type StoredRow = Record<string, unknown>

export interface Harness {
  /**
   * Run `body` with its table and `MainTable`'s layer, on a table made from its definition with
   * the indexes named, and answer with what `body` did and the rows stored.
   */
  readonly on: <A, E>(
    MainTable: any,
    body: (
      rows: () => Effect.Effect<ReadonlyArray<StoredRow>, unknown, any>,
      /** Run `effect` under another definition of this table. */
      as: <B, F>(other: any, effect: Effect.Effect<B, F, any>) => Effect.Effect<B, F, any>,
    ) => Effect.Effect<A, E, any>,
  ) => Effect.Effect<A, unknown>
}

type Scenario = {
  readonly name: string
  readonly run: (h: Harness) => Effect.Effect<void, unknown>
}

const library: Library = {
  Effect,
  Schema,
  DynamoSchema,
  Entity,
  Table,
  EventStore,
  Aggregate,
  DynamoClient,
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/rows-1.36.0.json", import.meta.url)), "utf8"),
) as {
  readonly generated: string
  readonly rows: Record<string, ReadonlyArray<Record<string, string>>>
}

const stored = (casing: Casing, values: "spelled" | "plain") => fixture.rows[`${casing}/${values}`]!

/** What a key does with a character: an independent spelling of the rule, to check it against. */
const escapeOf = (text: string, casing: Casing): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the rule's range starts at U+0000
  text.replace(/[\u0000-%]/g, (character) => {
    const hex = character.charCodeAt(0).toString(16).padStart(2, "0")
    return `%${casing === "lowercase" ? hex : hex.toUpperCase()}`
  })

const cased = (text: string, casing: Casing) =>
  casing === "lowercase" ? text.toLowerCase() : casing === "uppercase" ? text.toUpperCase() : text

/**
 * What 1.36 stored, each value escaped: under the schema's casing, and for the one stream with a
 * casing of its own, under that. A command's sentinel holds an id, not a composite: it's only
 * read by its exact key, and stays as it is.
 */
const escapedForm = (
  rows: ReadonlyArray<Record<string, string>>,
  casing: Casing,
): ReadonlyArray<Record<string, string>> => {
  const values = Object.values(SPELLED).sort((a, b) => b.length - a.length)
  return keysOf(
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([name, text]) => {
          if (name === "__edd_e__") return [name, text]
          if (name === "sk" && row.__edd_e__!.endsWith(".command")) return [name, text]
          const under: Casing = row.__edd_e__ === "ledgers.event" ? "preserve" : casing
          let out = text
          // In one pass, so what one replacement wrote isn't read by the next.
          const forms = values.map((value) => cased(value, under))
          const pattern = new RegExp(
            forms.map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
            "g",
          )
          out = out.replace(pattern, (form) => escapeOf(form, under))
          return [name, out]
        }),
      ),
    ),
  )
}

const writes = (
  h: Harness,
  casing: Casing,
  escapeKeys: boolean,
  values: Values,
  numbers: Numbers = PADDED,
) => {
  const world = makeWorld(library, { casing, escapeKeys })
  return h.on(world.MainTable, (rows) =>
    Effect.gen(function* () {
      yield* writeEveryKey(library, world, values, numbers) as Effect.Effect<void, unknown, any>
      return keysOf(yield* rows())
    }),
  )
}

export const everyKeyScenarios: ReadonlyArray<Scenario> = CASINGS.flatMap((casing) => [
  {
    name: `${casing}, off: every key is what the published 1.36.0 stored, byte for byte`,
    run: (h: Harness) =>
      Effect.gen(function* () {
        expect(yield* writes(h, casing, false, SPELLED)).toEqual(stored(casing, "spelled"))
        expect(yield* writes(h, casing, false, PLAIN)).toEqual(stored(casing, "plain"))
      }),
  },
  {
    name: `${casing}, on: a value with nothing to escape stores what 1.36.0 stored`,
    run: (h: Harness) =>
      Effect.gen(function* () {
        expect(yield* writes(h, casing, true, PLAIN)).toEqual(stored(casing, "plain"))
      }),
  },
  {
    name: `${casing}, on: every key escapes every value, and only the values`,
    run: (h: Harness) =>
      Effect.gen(function* () {
        const expected = escapedForm(stored(casing, "spelled"), casing)
        expect(expected).not.toEqual(stored(casing, "spelled"))
        expect(yield* writes(h, casing, true, SPELLED)).toEqual(expected)
      }),
  },
])

/** Every key path's read, finding what `writeEveryKey` wrote. */
const readsEveryKey = (world: ReturnType<typeof makeWorld>, v: Values, numbers: Numbers = PADDED) =>
  Effect.gen(function* () {
    const db: any = yield* world.client()
    const item = { tenant: v.a, n: numbers.n, label: v.b, s: numbers.s }
    expect(yield* db.entities.Items.get(item).asEffect()).toMatchObject({ zone: v.d })
    const byRegion = yield* db.entities.Items.byRegion({ region: v.c, zone: v.d }).collect()
    expect(byRegion.map((row: any) => row.tenant)).toEqual([v.a])
    const byTeam = yield* db.entities.Members.byTeam({ teamId: v.b, memberId: v.a }).collect()
    expect(byTeam.map((row: any) => row.orgId)).toEqual([v.c])
    const byOrg = yield* db.entities.Members.byOrg({ orgId: v.c }).collect()
    expect(byOrg.map((row: any) => row.teamId)).toEqual([v.b])
    const team = yield* db.collections.team({ teamId: v.b }).collect()
    expect(team.Members.map((row: any) => row.orgId)).toEqual([v.c])
    // A sentinel holds: the address is taken, under its current key.
    const taken = yield* db.entities.Users.put({ id: "other", email: v.d })
      .asEffect()
      .pipe(Effect.flip)
    expect((taken as any)._tag).toBe("UniqueConstraintViolation")
    expect(yield* db.entities.Users.get({ id: v.c }).asEffect()).toMatchObject({ email: v.d })
    expect(yield* db.entities.Users.getVersion({ id: v.a }, 1)).toMatchObject({ email: v.b })
    expect(yield* db.entities.Users.deleted.get({ id: v.a })).toMatchObject({ email: v.b })
    const history = yield* db.entities.Readings.history({ device: v.a, channel: v.b }).collect()
    expect(history.map((row: any) => row.at)).toEqual([numbers.at])
    const byGroup = yield* db.entities.Edges.byGroup({ groupId: v.b }).collect()
    expect(byGroup.map((row: any) => row.userId)).toEqual([v.a])
    expect((yield* world.Accounts.read({ tenant: v.a, n: numbers.n })).length).toBe(1)
    expect((yield* world.Ledgers.read({ tenant: v.d })).length).toBe(1)
    const route = yield* db.aggregates.Routes.get({ id: v.a })
    expect(route.stops.map((stop: any) => stop.label)).toEqual([v.c])
    const listed = yield* db.aggregates.Routes.list({ area: v.b })
    expect(listed.data.map((row: any) => row.id)).toEqual([v.a])
  })

const rekeyOf = (world: ReturnType<typeof makeWorld>, options?: { readonly dryRun?: boolean }) =>
  Effect.gen(function* () {
    const db: any = yield* world.client()
    return yield* db.tables.MainTable.rekey({
      streams: [world.Accounts, world.Ledgers],
      ...options,
    })
  }) as Effect.Effect<Table.RekeyReport, unknown, any>

const expectNothingMoved = (report: Table.RekeyReport) => {
  expect(report.moved).toMatchObject({ item: 0, aggregate: 0, stream: 0 })
  expect(report.sentinelsMoved).toBe(0)
  expect(report.indexKeysRewritten).toBe(0)
  expect(report.conflicts).toEqual([])
  expect(report.skipped.unrecognizedKey).toBe(0)
}

export const findsEveryKeyScenarios: ReadonlyArray<Scenario> = CASINGS.flatMap((casing) =>
  (
    [
      ["on", true],
      ["off", false],
    ] as const
  ).map(([label, escapeKeys]) => ({
    name: `${casing}, ${label}: each key path finds what it wrote, and rekey leaves it`,
    run: (h: Harness) => {
      const world = makeWorld(library, { casing, escapeKeys })
      return h.on(world.MainTable, () =>
        Effect.gen(function* () {
          yield* writeEveryKey(library, world, SPELLED) as Effect.Effect<void, unknown, any>
          yield* readsEveryKey(world, SPELLED)
          expectNothingMoved(yield* rekeyOf(world))
          yield* readsEveryKey(world, SPELLED)
        }),
      )
    },
  })),
)

/** Nothing of `SPELLED` is found by any key path, under the setting that didn't write it. */
const findsNothing = (world: ReturnType<typeof makeWorld>) =>
  Effect.gen(function* () {
    const db: any = yield* world.client()
    const v = SPELLED
    const gone = yield* db.entities.Items.get({ tenant: v.a, n: 5, label: v.b, s: 7 })
      .asEffect()
      .pipe(Effect.flip)
    expect((gone as any)._tag).toBe("ItemNotFound")
    expect(yield* db.entities.Items.byRegion({ region: v.c, zone: v.d }).collect()).toEqual([])
    expect(yield* world.Accounts.read({ tenant: v.a, n: 5 })).toHaveLength(0)
    const route = yield* db.aggregates.Routes.get({ id: v.a }).pipe(Effect.flip)
    expect((route as any)._tag).toBe("AggregateAssemblyError")
  })

type ReleaseFixture = {
  readonly generated: string
  readonly rows: Record<string, ReadonlyArray<Record<string, any>>>
}

const RELEASES = ["1.37.0", "1.38.0"] as const
const releaseFixture = Object.fromEntries(
  RELEASES.map((release) => [
    release,
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../fixtures/rows-${release}.json`, import.meta.url)),
        "utf8",
      ),
    ) as ReleaseFixture,
  ]),
) as Record<(typeof RELEASES)[number], ReleaseFixture>

const RELEASE_SETS: ReadonlyArray<{
  readonly label: string
  readonly values: Values
  readonly numbers: Numbers
}> = [
  { label: "spelled", values: SPELLED, numbers: PADDED },
  { label: "plain", values: PLAIN, numbers: PADDED },
  { label: "spelled-changed", values: SPELLED, numbers: CHANGED },
  { label: "plain-changed", values: PLAIN, numbers: CHANGED },
]

/** A key attribute's text, from the attribute map a fixture holds. */
const attributeKeysOf = (rows: ReadonlyArray<Record<string, any>>) =>
  keysOf(
    rows.map((row) =>
      Object.fromEntries(Object.entries(row).map(([name, value]) => [name, value.S])),
    ),
  )

/**
 * The rows the published 1.37.0 and 1.38.0 stored: 1.37.0's key text, which 1.38.0 didn't change.
 * `rekey` brings them to what a fresh write under either setting stores, with the inverted row, a
 * chain of escapes and the numbers 1.37.0 changed among them.
 */
export const releaseRowScenarios: ReadonlyArray<Scenario> = [
  {
    name: "1.38.0 stored every key 1.37.0 did",
    run: () =>
      Effect.sync(() => {
        for (const [set, rows] of Object.entries(releaseFixture["1.37.0"].rows)) {
          expect(attributeKeysOf(releaseFixture["1.38.0"].rows[set]!)).toEqual(
            attributeKeysOf(rows),
          )
        }
      }),
  },
  ...RELEASES.flatMap((release) =>
    CASINGS.flatMap((casing) =>
      RELEASE_SETS.flatMap(({ label, values, numbers }) =>
        (
          [
            ["on", true],
            ["off", false],
          ] as const
        ).map(([setting, escapeKeys]) => ({
          name: `${release}, ${casing}, ${label}, ${setting}: rekey brings every row to what the setting stores`,
          run: (h: Harness) => {
            const world = makeWorld(library, { casing, escapeKeys })
            return Effect.gen(function* () {
              const fresh = yield* writes(h, casing, escapeKeys, values, numbers)
              yield* h.on(world.MainTable, (rows) =>
                Effect.gen(function* () {
                  const client: any = yield* DynamoClient
                  const { name: TableName } = yield* world.MainTable.Tag
                  for (const Item of releaseFixture[release].rows[`${casing}/${label}`]!) {
                    yield* client.putItem({ TableName, Item })
                  }
                  const before = keysOf(yield* rows())
                  const dry = yield* rekeyOf(world, { dryRun: true })
                  expect(keysOf(yield* rows())).toEqual(before)
                  const report = yield* rekeyOf(world)
                  expect(report.conflicts).toEqual([])
                  expect(report.skipped.unrecognizedKey).toBe(0)
                  expect(dry.moved).toEqual(report.moved)
                  expect(dry.sentinelsMoved).toBe(report.sentinelsMoved)
                  expect(dry.indexKeysRewritten).toBe(report.indexKeysRewritten)
                  expect(dry.conflicts).toEqual([])
                  expect(keysOf(yield* rows())).toEqual(fresh)
                  // Nothing here to move: a plain value has one text in every release.
                  if (label === "plain") expectNothingMoved(report)
                  if (!escapeKeys && (label === "spelled" || label === "plain")) {
                    expect(keysOf(yield* rows())).toEqual(stored(casing, label))
                  }
                  yield* readsEveryKey(world, values, numbers)
                  expectNothingMoved(yield* rekeyOf(world))
                  expect(keysOf(yield* rows())).toEqual(fresh)
                  yield* readsEveryKey(world, values, numbers)
                }),
              )
            })
          },
        })),
      ),
    ),
  ),
]

/**
 * Turning escaping on or off over stored rows: until `rekey` moves them no read finds a row whose
 * text changed, and after it the stored bytes are what a fresh write under the setting stores.
 */
export const flipScenarios: ReadonlyArray<Scenario> = CASINGS.flatMap((casing) => [
  {
    name: `${casing}, off to on: nothing is found, rekey moves all of it`,
    run: (h: Harness) => {
      const off = makeWorld(library, { casing, escapeKeys: false })
      const on = makeWorld(library, { casing, escapeKeys: true })
      return h.on(off.MainTable, (rows, as) =>
        Effect.gen(function* () {
          yield* writeEveryKey(library, off, SPELLED) as Effect.Effect<void, unknown, any>
          yield* as(on.MainTable, findsNothing(on))
          const report = yield* as(on.MainTable, rekeyOf(on))
          expect(report.conflicts).toEqual([])
          expect(report.skipped.unrecognizedKey).toBe(0)
          // The same bytes a fresh write under `on` stores.
          expect(keysOf(yield* rows())).toEqual(escapedForm(stored(casing, "spelled"), casing))
          yield* as(on.MainTable, readsEveryKey(on, SPELLED))
          expectNothingMoved(yield* as(on.MainTable, rekeyOf(on)))
          yield* as(on.MainTable, readsEveryKey(on, SPELLED))
        }),
      )
    },
  },
  {
    name: `${casing}, on to off: rekey moves it all back, to what the published 1.36.0 stored`,
    run: (h: Harness) => {
      const on = makeWorld(library, { casing, escapeKeys: true })
      const off = makeWorld(library, { casing, escapeKeys: false })
      return h.on(on.MainTable, (rows, as) =>
        Effect.gen(function* () {
          yield* writeEveryKey(library, on, SPELLED) as Effect.Effect<void, unknown, any>
          yield* as(off.MainTable, findsNothing(off))
          const report = yield* as(off.MainTable, rekeyOf(off))
          expect(report.conflicts).toEqual([])
          expect(report.skipped.unrecognizedKey).toBe(0)
          expect(keysOf(yield* rows())).toEqual(stored(casing, "spelled"))
          yield* as(off.MainTable, readsEveryKey(off, SPELLED))
          expectNothingMoved(yield* as(off.MainTable, rekeyOf(off)))
          yield* as(off.MainTable, readsEveryKey(off, SPELLED))
        }),
      )
    },
  },
  {
    name: `${casing}, a value with nothing to escape: found under either setting, nothing moves`,
    run: (h: Harness) => {
      const on = makeWorld(library, { casing, escapeKeys: true })
      const off = makeWorld(library, { casing, escapeKeys: false })
      return h.on(on.MainTable, (_rows, as) =>
        Effect.gen(function* () {
          yield* writeEveryKey(library, on, PLAIN) as Effect.Effect<void, unknown, any>
          yield* as(off.MainTable, readsEveryKey(off, PLAIN))
          expectNothingMoved(yield* as(off.MainTable, rekeyOf(off)))
          expectNothingMoved(yield* as(on.MainTable, rekeyOf(on)))
          yield* as(on.MainTable, readsEveryKey(on, PLAIN))
        }),
      )
    },
  },
])

/** A unique sentinel at the other setting's text, on an item whose primary key text didn't change. */
export const sentinelScenarios: ReadonlyArray<Scenario> = (() => {
  const setup = (
    h: Harness,
    from: boolean,
    body: (now: ReturnType<typeof makeWorld>) => Effect.Effect<void, unknown, any>,
  ) => {
    const before = makeWorld(library, { casing: "lowercase", escapeKeys: from })
    const now = makeWorld(library, { casing: "lowercase", escapeKeys: !from })
    return h.on(before.MainTable, (_rows, as) =>
      Effect.gen(function* () {
        const db: any = yield* before.client()
        yield* db.entities.Users.put({ id: "plain", email: "e f" }).asEffect()
        yield* as(now.MainTable, body(now))
      }),
    )
  }
  const claim = (db: any, email: string) =>
    db.entities.Users.put({ id: "other", email })
      .asEffect()
      .pipe(
        Effect.flip,
        Effect.map((error: any) => error._tag),
      )
  return [true, false].flatMap((from) => {
    const label = from ? "on to off" : "off to on"
    return [
      {
        name: `${label}: until rekey it refuses nothing, and rekey reports the value taken twice`,
        run: (h: Harness) =>
          setup(h, from, (now) =>
            Effect.gen(function* () {
              const db: any = yield* now.client()
              yield* db.entities.Users.put({ id: "other", email: "e f" }).asEffect()
              const report = yield* rekeyOf(now)
              expect(report.sentinelsMoved).toBe(0)
              expect(report.conflicts.length).toBeGreaterThan(0)
              const third = yield* db.entities.Users.put({ id: "third", email: "e f" })
                .asEffect()
                .pipe(Effect.flip)
              expect((third as any)._tag).toBe("UniqueConstraintViolation")
            }),
          ),
      },
      {
        name: `${label}: rekey moves it, leaving the item where it is, and it refuses`,
        run: (h: Harness) =>
          setup(h, from, (now) =>
            Effect.gen(function* () {
              const db: any = yield* now.client()
              const dry = yield* db.tables.MainTable.rekey({ dryRun: true }) as Effect.Effect<
                Table.RekeyReport,
                unknown,
                any
              >
              expect(dry.sentinelsMoved).toBe(1)
              const report = yield* rekeyOf(now)
              expect(report.moved.item).toBe(0)
              expect(report.sentinelsMoved).toBe(1)
              expect(yield* claim(db, "e f")).toBe("UniqueConstraintViolation")
              expectNothingMoved(yield* rekeyOf(now))
            }),
          ),
      },
      {
        name: `${label}: after rekey, changing the value releases it`,
        run: (h: Harness) =>
          setup(h, from, (now) =>
            Effect.gen(function* () {
              const db: any = yield* now.client()
              yield* rekeyOf(now)
              yield* db.entities.Users.update({ id: "plain" }).set({ email: "g h" }).asEffect()
              yield* db.entities.Users.put({ id: "other", email: "e f" }).asEffect()
              yield* db.entities.Users.delete({ id: "other" }).asEffect()
              yield* db.entities.Users.put({ id: "next", email: "e f" }).asEffect()
              expect(yield* claim(db, "g h")).toBe("UniqueConstraintViolation")
            }),
          ),
      },
      {
        name: `${label}: after rekey, purging the item releases it`,
        run: (h: Harness) =>
          setup(h, from, (now) =>
            Effect.gen(function* () {
              const db: any = yield* now.client()
              yield* rekeyOf(now)
              yield* db.entities.Users.purge({ id: "plain" })
              yield* db.entities.Users.put({ id: "other", email: "e f" }).asEffect()
            }),
          ),
      },
    ]
  })
})()

// ---------------------------------------------------------------------------
// The canonical GSI shapes
// ---------------------------------------------------------------------------

const Fleet = Schema.Struct({
  channel: Schema.String,
  deviceId: Schema.String,
  accountId: Schema.optional(Schema.String),
  alertState: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Number),
  region: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  city: Schema.optional(Schema.String),
  zone: Schema.optional(Schema.String),
  hubId: Schema.optional(Schema.String),
  deviceBinding: Schema.optional(Schema.String),
  tenantId: Schema.optional(Schema.String),
  groupId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  tag: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
})

const fleetsOf = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "shapes", version: 1, escapeKeys })
  const Fleets = Entity.make({
    model: Fleet,
    entityType: "Fleet",
    primaryKey: {
      pk: { field: "pk", composite: ["channel"] },
      sk: { field: "sk", composite: ["deviceId"] },
    },
    indexes: {
      multiWriter: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["accountId"] },
        sk: { field: "gsi1sk", composite: ["alertState", "timestamp"] },
      },
      byChannel: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["channel"] },
        sk: { field: "gsi2sk", composite: ["deviceId"] },
      },
      byPlace: {
        name: "gsi3",
        pk: { field: "gsi3pk", composite: ["region"] },
        sk: { field: "gsi3sk", composite: ["country", "city"] },
      },
      byHub: {
        name: "gsi4",
        pk: { field: "gsi4pk", composite: ["zone", "hubId"] },
        sk: { field: "gsi4sk", composite: ["status"] },
      },
      byGroup: {
        name: "gsi5",
        pk: { field: "gsi5pk", composite: ["tenantId"] },
        sk: { field: "gsi5sk", composite: ["groupId", "status"] },
      },
      byBinding: {
        name: "gsi6",
        pk: { field: "gsi6pk", composite: ["deviceBinding"] },
        sk: { field: "gsi6sk", composite: [] },
      },
      // A new degenerate shape: both halves over one composite.
      byTag: {
        name: "gsi7",
        pk: { field: "gsi7pk", composite: ["tag"] },
        sk: { field: "gsi7sk", composite: ["tag"] },
      },
    },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Fleets } }) as any
  return { Fleets, MainTable, escapeKeys }
}

type Fleets = ReturnType<typeof fleetsOf>

const clientOf = (world: Fleets) =>
  DynamoClient.make({
    entities: { Fleets: world.Fleets },
    tables: { MainTable: world.MainTable },
  } as never) as unknown as Effect.Effect<any, never, any>

const CHANNEL = "c d"
const DEVICE = "x#y"
const key = { channel: CHANNEL, deviceId: DEVICE }
const whole = {
  ...key,
  accountId: "a b",
  alertState: "o k",
  timestamp: 7,
  region: "r s",
  country: "5%",
  city: "new york",
  zone: "z#z",
  hubId: "h i",
  deviceBinding: "b c",
  tenantId: "t u",
  groupId: "g#h",
  status: "o n",
}

/** A composite's text under `world`'s setting. */
const text = (world: Fleets, value: string): string => {
  const lower = value.toLowerCase()
  return world.escapeKeys ? escapeOf(lower, "lowercase") : lower
}

const storedRow = (rows: ReadonlyArray<StoredRow>) => {
  const row = rows.find((candidate) => candidate.__edd_e__ === "Fleet")
  expect(row).toBeDefined()
  return row as Record<string, string | undefined>
}

const deviceIds = (rows: ReadonlyArray<any>) => rows.map((row) => row.deviceId)

const shapesFor = (world: Fleets, label: string): ReadonlyArray<Scenario> => {
  const shape = (
    name: string,
    body: (
      db: any,
      rows: () => Effect.Effect<ReadonlyArray<StoredRow>, unknown, any>,
    ) => Effect.Effect<void, unknown, any>,
  ): Scenario => ({
    name: `${label}: ${name}`,
    run: (h) =>
      h.on(world.MainTable, (rows) =>
        Effect.gen(function* () {
          const db = yield* clientOf(world)
          yield* body(db, rows)
        }),
      ),
  })
  return [
    shape(
      "an unrelated update leaves every index key, and each accessor finds the item",
      (db, rows) =>
        Effect.gen(function* () {
          const fleets = db.entities.Fleets
          yield* fleets.put(whole).asEffect()
          const before = storedRow(yield* rows())
          yield* fleets.update(key).set({ note: "n" }).asEffect()
          const after = storedRow(yield* rows())
          for (const name of Object.keys(before).filter((attr) => /^gsi\dpk|^gsi\dsk/.test(attr))) {
            expect(after[name], name).toBe(before[name])
          }
          const everyAccessor = {
            multiWriter: yield* fleets.multiWriter({ accountId: "a b" }).collect(),
            byChannel: yield* fleets.byChannel({ channel: CHANNEL }).collect(),
            byPlace: yield* fleets.byPlace({ region: "r s" }).collect(),
            byHub: yield* fleets.byHub({ zone: "z#z", hubId: "h i" }).collect(),
            byGroup: yield* fleets.byGroup({ tenantId: "t u" }).collect(),
            byBinding: yield* fleets.byBinding({ deviceBinding: "b c" }).collect(),
          }
          for (const [name, found] of Object.entries(everyAccessor)) {
            expect(deviceIds(found as ReadonlyArray<any>), name).toEqual([DEVICE])
          }
        }),
    ),
    shape("shape 1, multi-writer: each writer composes its half and leaves the other", (db, rows) =>
      Effect.gen(function* () {
        const fleets = db.entities.Fleets
        yield* fleets.put(whole).asEffect()
        const before = storedRow(yield* rows())
        yield* fleets.update(key).set({ accountId: "m n" }).asEffect()
        const enriched = storedRow(yield* rows())
        expect(enriched.gsi1pk).toBe(`$shapes#v1#fleet#accountid_${text(world, "m n")}`)
        expect(enriched.gsi1sk).toBe(before.gsi1sk)
        yield* fleets.update(key).set({ alertState: "a#b", timestamp: 8 }).asEffect()
        const telemetry = storedRow(yield* rows())
        expect(telemetry.gsi1pk).toBe(enriched.gsi1pk)
        expect(telemetry.gsi1sk).toBe(
          `$shapes#v1#fleet#alertstate_${text(world, "a#b")}#timestamp_0000000000000008`,
        )
      }),
    ),
    shape(
      "shape 2, PK-composites-only: the half composes, on an item that lacked it too",
      (db, rows) =>
        Effect.gen(function* () {
          const fleets = db.entities.Fleets
          yield* fleets.put(key).asEffect()
          yield* fleets.update(key).set({ note: "n" }).asEffect()
          const row = storedRow(yield* rows())
          expect(row.gsi2pk).toBe(`$shapes#v1#fleet#channel_${text(world, CHANNEL)}`)
          expect(row.gsi2sk).toBe(`$shapes#v1#fleet#deviceid_${text(world, DEVICE)}`)
          expect(deviceIds(yield* fleets.byChannel({ channel: CHANNEL }).collect())).toEqual([
            DEVICE,
          ])
        }),
    ),
    shape(
      "shape 3, hierarchical: `.remove` truncates, and the pin on the level finds it",
      (db, rows) =>
        Effect.gen(function* () {
          const fleets = db.entities.Fleets
          yield* fleets.put(whole).asEffect()
          yield* fleets
            .update(key)
            .set({ region: "r s", country: "5%" })
            .remove(["city"])
            .asEffect()
          expect(storedRow(yield* rows()).gsi3sk).toBe(
            `$shapes#v1#fleet#country_${text(world, "5%")}`,
          )
          // Off, a pin selects below the level, as in 1.36, so the row truncated at it isn't found.
          expect(
            deviceIds(yield* fleets.byPlace({ region: "r s", country: "5%" }).collect()),
          ).toEqual(label === "on" ? [DEVICE] : [])
          expect(deviceIds(yield* fleets.byPlace({ region: "r s" }).collect())).toEqual([DEVICE])
        }),
    ),
    shape("shape 4, a hole: 'preserve' leaves the key, `.remove` takes the entry out", (db, rows) =>
      Effect.gen(function* () {
        const fleets = db.entities.Fleets
        yield* fleets.put(whole).asEffect()
        const before = storedRow(yield* rows())
        yield* fleets.update(key).set({ hubId: "h j" }).asEffect()
        expect(storedRow(yield* rows()).gsi4pk).toBe(before.gsi4pk)
        yield* fleets.update(key).remove(["zone"]).asEffect()
        expect(storedRow(yield* rows()).gsi4pk).toBeUndefined()
      }),
    ),
    shape("shape 5, all composites mutable: the payload moves the entry", (db) =>
      Effect.gen(function* () {
        const fleets = db.entities.Fleets
        yield* fleets.put(whole).asEffect()
        yield* fleets.update(key).set({ tenantId: "t u", groupId: "g#i", status: "o f" }).asEffect()
        const on = (groupId: string) => fleets.byGroup({ tenantId: "t u", groupId }).collect()
        expect(deviceIds(yield* on("g#h"))).toEqual([])
        expect(deviceIds(yield* on("g#i"))).toEqual([DEVICE])
      }),
    ),
    shape("shape 6, an empty half: the constant prefix is written, the entry stays", (db, rows) =>
      Effect.gen(function* () {
        const fleets = db.entities.Fleets
        yield* fleets.put(key).asEffect()
        yield* fleets.update(key).set({ deviceBinding: "b c" }).asEffect()
        const row = storedRow(yield* rows())
        expect(row.gsi6pk).toBe(`$shapes#v1#fleet#devicebinding_${text(world, "b c")}`)
        expect(row.gsi6sk).toBe("$shapes#v1#fleet")
        yield* fleets.update(key).set({ note: "n" }).asEffect()
        expect(deviceIds(yield* fleets.byBinding({ deviceBinding: "b c" }).collect())).toEqual([
          DEVICE,
        ])
      }),
    ),
    shape("both halves over one composite, a value only of what a key escapes", (db) =>
      Effect.gen(function* () {
        const fleets = db.entities.Fleets
        const tags = ["#", "%", "%23", "%25", " ", "# #"]
        for (const [i, tag] of tags.entries()) {
          yield* fleets.put({ channel: CHANNEL, deviceId: `d${i}`, tag }).asEffect()
        }
        for (const [i, tag] of tags.entries()) {
          expect(deviceIds(yield* fleets.byTag({ tag }).collect()), tag).toEqual([`d${i}`])
        }
      }),
    ),
  ]
}

export const shapeScenarios: ReadonlyArray<Scenario> = [
  ...shapesFor(fleetsOf(true), "on"),
  ...shapesFor(fleetsOf(false), "off"),
]

// ---------------------------------------------------------------------------
// A time series' bounds
// ---------------------------------------------------------------------------

const Reading = Schema.Struct({
  site: Schema.String,
  meter: Schema.String,
  at: Schema.String,
  note: Schema.String,
})

const readingsOf = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "series", version: 1, escapeKeys })
  const Readings = Entity.make({
    model: Reading,
    entityType: "Reading",
    primaryKey: {
      pk: { field: "pk", composite: ["site"] },
      sk: { field: "sk", composite: ["meter"] },
    },
    timeSeries: { orderBy: "at", appendInput: Reading },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Readings } }) as any
  return { Readings, MainTable }
}

/** In key order under either setting: `a`, then what extends it below `#`, then `b`. */
const READINGS = ["a", "a b", "a!", "b"]

const historyScenario = (escapeKeys: boolean): Scenario => ({
  name: `a history bound finds a value the key ${escapeKeys ? "escapes" : "holds raw"}`,
  run: (h) => {
    const { Readings, MainTable } = readingsOf(escapeKeys)
    return h.on(MainTable, (rows) =>
      Effect.gen(function* () {
        const db: any = yield* DynamoClient.make({
          entities: { Readings },
          tables: { MainTable },
        } as never)
        const key = { site: "s", meter: "m" }
        for (const at of READINGS) {
          yield* db.entities.Readings.append({ ...key, at, note: at }).asEffect()
        }
        const stored = (yield* rows()).map((row) => String(row.sk))
        expect(stored).toContain(`$series#v1#reading#meter_m#e#a${escapeKeys ? "%20" : " "}b`)
        const within = (where: (t: any, ops: any) => unknown) =>
          db.entities.Readings.history(key)
            .where(where)
            .collect()
            .pipe(Effect.map((found: ReadonlyArray<any>) => found.map((row) => row.at)))
        expect(yield* within((t, { eq }) => eq(t.at, "a b"))).toEqual(["a b"])
        expect(yield* within((t, { lte }) => lte(t.at, "a b"))).toEqual(["a", "a b"])
        expect(yield* within((t, { lt }) => lt(t.at, "a!"))).toEqual(["a", "a b"])
        expect(yield* within((t, { gte }) => gte(t.at, "a!"))).toEqual(["a!", "b"])
        expect(yield* within((t, { between }) => between(t.at, "a b", "a!"))).toEqual(["a b", "a!"])
        // The bound stays past the value's own key, which off lets a longer value sort below.
        expect(yield* within((t, { gt }) => gt(t.at, "a"))).toEqual(
          escapeKeys ? ["a b", "a!", "b"] : ["b"],
        )
      }),
    ) as never
  },
})

export const historyScenarios: ReadonlyArray<Scenario> = [
  historyScenario(true),
  historyScenario(false),
]

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

const Track = Schema.Struct({ owner: Schema.String, id: Schema.String })

const tracksOf = (escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "tracks", version: 1, escapeKeys })
  const Tracks = Entity.make({
    model: Track,
    entityType: "Track",
    primaryKey: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byOwner: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["owner"] },
        sk: { field: "gsi1sk", composite: ["id"] },
      },
      byShard: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["owner"] },
        sk: { field: "gsi2sk", composite: ["id"] },
        shards: { count: 4, by: ["id"] },
      },
    },
  } as never) as any
  const MainTable = Table.make({ schema, entities: { Tracks } }) as any
  const client = DynamoClient.make({
    entities: { Tracks },
    tables: { MainTable },
  } as never) as unknown as Effect.Effect<any, never, any>
  return { MainTable, client }
}

const TRACKS = ["1", "2", "3", "4", "5"]
const idsOf = (rows: ReadonlyArray<any>) => rows.map((row) => row.id)

const writeTracks = (db: any, owner: string) =>
  Effect.forEach(TRACKS, (id) => db.entities.Tracks.put({ owner, id }).asEffect(), {
    discard: true,
  })

const pageOf = (query: any) => query.limit(2).fetch()

/** Both settings' clients on one table, with rows written under `from` and its first page. */
const flipped = (
  h: Harness,
  from: boolean,
  body: (
    page: (query: (db: any) => any) => Effect.Effect<any, unknown, any>,
    resume: (query: (db: any) => any, cursor: string) => Effect.Effect<any, unknown, any>,
  ) => Effect.Effect<void, unknown, any>,
) => {
  const before = tracksOf(from)
  const after = tracksOf(!from)
  return h.on(before.MainTable, (_rows, as) =>
    Effect.gen(function* () {
      const db: any = yield* before.client
      yield* writeTracks(db, "a b")
      yield* body(
        (query) => pageOf(query(db)),
        (query, cursor) =>
          as(
            after.MainTable,
            Effect.flatMap(after.client, (other: any) =>
              query(other).startFrom(cursor).collect(),
            ) as Effect.Effect<any, unknown, any>,
          ),
      )
    }),
  ) as never
}

const byOwner = (db: any) => db.entities.Tracks.byOwner({ owner: "a b" })
const byShard = (db: any) => db.entities.Tracks.byShard({ owner: "a b" })
const fromTwo = (db: any) => byOwner(db).where((t: any, { gte }: any) => gte(t.id, "2"))

/** DynamoDB refuses a start key outside the query's partition, and an in-memory table finds none. */
const expectNoRows = (resumed: Effect.Effect<any, unknown, any>) =>
  resumed.pipe(
    Effect.catch((error: any) =>
      error._tag === "DynamoValidationError" ? Effect.succeed([]) : Effect.fail(error),
    ),
    Effect.map((rows) => expect(idsOf(rows)).toEqual([])),
  )

export const cursorScenarios: ReadonlyArray<Scenario> = [
  ...[true, false].map(
    (escapeKeys): Scenario => ({
      name: `a sharded query's cursor resumes under its own setting, ${escapeKeys ? "on" : "off"}`,
      run: (h) => {
        const world = tracksOf(escapeKeys)
        return h.on(world.MainTable, () =>
          Effect.gen(function* () {
            const db: any = yield* world.client
            yield* writeTracks(db, "a b")
            const first: any = yield* pageOf(byShard(db))
            const rest = yield* byShard(db).startFrom(first.cursor.value).collect()
            expect([...idsOf(first.items), ...idsOf(rest)]).toEqual(TRACKS)
          }),
        ) as never
      },
    }),
  ),
  ...[true, false].map(
    (from): Scenario => ({
      name: `a sharded query's cursor is refused under the other setting, from ${from ? "on" : "off"}`,
      run: (h) =>
        flipped(h, from, (page, resume) =>
          Effect.gen(function* () {
            const first: any = yield* page(byShard)
            const error: any = yield* Effect.flip(resume(byShard, first.cursor.value))
            expect(error._tag).toBe("ValidationError")
            expect(String(error.cause)).toContain("EDD-9094")
          }),
        ),
    }),
  ),
  {
    name: "a cursor from before escaping went on finds no rows of another partition",
    run: (h) =>
      flipped(h, false, (page, resume) =>
        Effect.gen(function* () {
          const first: any = yield* page(byOwner)
          expect(idsOf(first.items)).toEqual(["1", "2"])
          yield* expectNoRows(resume(byOwner, first.cursor.value))
        }),
      ),
  },
  {
    name: "a range bound's cursor from before escaping went on finds no rows of another partition",
    run: (h) =>
      flipped(h, false, (page, resume) =>
        Effect.gen(function* () {
          const first: any = yield* page(fromTwo)
          expect(idsOf(first.items)).toEqual(["2", "3"])
          yield* expectNoRows(resume(fromTwo, first.cursor.value))
        }),
      ),
  },
  ...[true, false].map(
    (from): Scenario => ({
      name: `a query reads nothing of a partition whose text changed until rekey moves it, from ${from ? "on" : "off"}`,
      run: (h) => {
        const before = tracksOf(from)
        const now = tracksOf(!from)
        return h.on(before.MainTable, (_rows, as) =>
          Effect.gen(function* () {
            const writer: any = yield* before.client
            yield* writeTracks(writer, "a b")
            yield* as(
              now.MainTable,
              Effect.gen(function* () {
                const db: any = yield* now.client
                expect(yield* fromTwo(db).collect()).toEqual([])
                expect(yield* byOwner(db).collect()).toEqual([])
                yield* db.tables.MainTable.rekey()
                expect(idsOf(yield* fromTwo(db).collect())).toEqual(["2", "3", "4", "5"])
                expect(idsOf(yield* byOwner(db).collect())).toEqual(TRACKS)
              }),
            )
          }),
        ) as never
      },
    }),
  ),
  {
    name: "a cursor from under escaping finds no rows of another partition once it is off",
    run: (h) =>
      flipped(h, true, (page, resume) =>
        Effect.gen(function* () {
          const first: any = yield* page(byOwner)
          yield* expectNoRows(resume(byOwner, first.cursor.value))
        }),
      ),
  },
]
