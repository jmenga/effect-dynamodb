/**
 * Rows 1.36 keyed under another value's key text (#171) — request capture.
 *
 * 1.36 did not escape sort key text, so its key of a value holding `%` and two
 * hex digits is another value's escaped key now (`foo%20bar`'s 1.36 key is
 * `foo bar`'s current key, `x%23y`'s is `x#y`'s), and its key of a value
 * holding `#` prefixes another value's key (`a b`'s live key prefixes
 * `a b#c`'s). Time-series events of a string-encoded numeric orderBy share
 * their item's event prefix in both forms (`#e#2` and `#e#0000000000000010`).
 * These tests run the ops against a recording in-memory table:
 *
 * - **Reads.** A row whose values compose another key is not the item: `get`,
 *   an accessor query and `history` judge each row by its own values.
 * - **Writes.** `put`, `update`, `delete` and `upsert` never write over, or
 *   delete, another value's row: it is moved to its own current key first.
 * - **Purge.** Removes the item's own rows only.
 * - **Versions.** A retained item created afresh continues after its own
 *   history, never another value's under its 1.36 prefix.
 *
 * `connected.legacy-keys.test.ts` runs the same pairs against DynamoDB Local.
 */

import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as KeyText136 from "@effect-dynamodb/schema/internal/KeyText136.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Effect, Layer, Schema } from "effect"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { fromAttributeMap, toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class Note extends Schema.Class<Note>("Note")({
  owner: Schema.String,
  title: Schema.String,
  body: Schema.String,
}) {}

class Tick extends Schema.Class<Tick>("Tick")({
  tickId: Schema.Number,
  at: Schema.NumberFromString,
  level: Schema.Number,
}) {}

const schema = DynamoSchema.make({ name: "alias", version: 1 })
const Notes = Entity.make({
  model: Note,
  entityType: "Note",
  primaryKey: {
    pk: { field: "pk", composite: ["owner"] },
    sk: { field: "sk", composite: ["title"] },
  },
  indexes: {
    byTitle: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["owner"] },
      sk: { field: "gsi1sk", composite: ["title"] },
    },
  },
})
const Ticks = Entity.make({
  model: Tick,
  entityType: "Tick",
  primaryKey: {
    pk: { field: "pk", composite: ["tickId"] },
    sk: { field: "sk", composite: [] },
  },
  timeSeries: {
    orderBy: "at",
    appendInput: Schema.Struct({
      tickId: Schema.Number,
      at: Schema.NumberFromString,
      level: Schema.Number,
    }),
  },
})
/** Notes retaining their versions, soft-deleted: an item's history prefix carries its title. */
const Pages = Entity.make({
  model: Note,
  entityType: "Page",
  primaryKey: {
    pk: { field: "pk", composite: ["owner"] },
    sk: { field: "sk", composite: ["title"] },
  },
  versioned: { retain: true },
  softDelete: true,
})
const MainTable = Table.make({ schema, entities: { Notes, Ticks, Pages } })

type Recording = ReturnType<typeof makeRecordingTable>

const freshTable = () => makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })

const clientOf = DynamoClient.make({ entities: { Notes, Ticks, Pages }, tables: { MainTable } })

/** Run `body` over `table`. */
const inTable = <A, E>(table: Recording, body: Effect.Effect<A, E, any>) =>
  body.pipe(
    Effect.provide(Layer.mergeAll(table.layer, MainTable.layer({ name: "t" }))),
  ) as Effect.Effect<A, E>

const at = (pk: string | undefined, sk: string | undefined) => `${pk}|${sk}`

const note = (title: string, body: string) => ({ owner: "o", title, body })

const keysOf = (title: string) => ({
  current: KeyComposer.composeAllKeys(schema, "Note", 1, Notes.indexes, { owner: "o", title }),
  old: KeyText136.composeAllKeys(schema, "Note", 1, Notes.indexes, { owner: "o", title }),
})

const pageKeysOf = (title: string) => ({
  current: KeyComposer.composeAllKeys(schema, "Page", 1, Pages.indexes, { owner: "o", title }),
  old: KeyText136.composeAllKeys(schema, "Page", 1, Pages.indexes, { owner: "o", title }),
})

/** Write `title`'s note as 1.36 did: every key in its 1.36 text. */
const seed136 = (table: Recording, title: string, body: string) => {
  const { old } = keysOf(title)
  table.items.set(at(old.pk, old.sk), {
    ...toAttributeMap({ ...note(title, body), ...old }),
    __edd_e__: { S: "Note" },
  })
}

/** The note stored at `title`'s current key, or under its 1.36 key. */
const storedAt = (table: Recording, key: Record<string, unknown>) => {
  const row = table.items.get(at(key.pk as string, key.sk as string))
  return row === undefined ? undefined : (fromAttributeMap(row) as Record<string, unknown>)
}

/** Each pair: a value holding `%XX`, and the value whose escaped text that spells. */
const PAIRS = [
  { spelled: "foo%20bar", value: "foo bar" },
  { spelled: "x%23y", value: "x#y" },
] as const

// ---------------------------------------------------------------------------
// A 1.36 row at another value's current key
// ---------------------------------------------------------------------------

describe("legacy keys — a 1.36 row at another value's current key", () => {
  for (const { spelled, value } of PAIRS) {
    it.effect(`${spelled}'s 1.36 row is not ${value}'s item: get and queries`, () =>
      Effect.gen(function* () {
        // The precondition: the 1.36 key of one is the current key of the other.
        expect(keysOf(spelled).old.sk).toBe(keysOf(value).current.sk)
        expect(keysOf(spelled).old.gsi1sk).toBe(keysOf(value).current.gsi1sk)
        const table = freshTable()
        seed136(table, spelled, "theirs")
        const db = yield* inTable(table, clientOf)
        const miss = yield* inTable(
          table,
          db.entities.Notes.get({ owner: "o", title: value }).asEffect().pipe(Effect.flip),
        )
        expect(miss._tag).toBe("ItemNotFound")
        const theirs = yield* inTable(
          table,
          db.entities.Notes.get({ owner: "o", title: spelled }).asEffect(),
        )
        expect(theirs.body).toBe("theirs")
        expect(
          yield* inTable(table, db.entities.Notes.byTitle({ owner: "o", title: value }).collect()),
        ).toEqual([])
        const found = yield* inTable(
          table,
          db.entities.Notes.byTitle({ owner: "o", title: spelled }).collect(),
        )
        expect(found.map((n) => n.body)).toEqual(["theirs"])
        // A prefix pin selects both rows, each once.
        const all = yield* inTable(table, db.entities.Notes.byTitle({ owner: "o" }).collect())
        expect(all.map((n) => n.title)).toEqual([spelled])
      }),
    )

    it.effect(`batch and transaction reads of ${value} miss ${spelled}'s 1.36 row`, () =>
      Effect.gen(function* () {
        const table = freshTable()
        seed136(table, spelled, "theirs")
        const mine = { owner: "o", title: value }
        const theirs = { owner: "o", title: spelled }
        const batch = yield* inTable(table, Batch.get([Notes.get(mine), Notes.get(theirs)]))
        expect(batch.map((n) => n?.body)).toEqual([undefined, "theirs"])
        const transact = yield* inTable(
          table,
          Transaction.transactGet([Notes.get(mine), Notes.get(theirs)]),
        )
        expect(transact.map((n) => n?.body)).toEqual([undefined, "theirs"])
      }),
    )

    it.effect(`Batch.write of ${value} and ${spelled} keeps each other's rows`, () =>
      Effect.gen(function* () {
        const table = freshTable()
        seed136(table, spelled, "theirs")
        // A put of one moves the other's 1.36 row out of the way.
        yield* inTable(table, Batch.write([Notes.put(note(value, "mine"))]))
        expect(storedAt(table, keysOf(value).current)?.body).toBe("mine")
        expect(storedAt(table, keysOf(spelled).current)?.body).toBe("theirs")
        // A delete of the other removes its row, and leaves this one's — at
        // the other's 1.36 key — alone.
        yield* inTable(table, Batch.write([Notes.delete({ owner: "o", title: spelled })]))
        expect(storedAt(table, keysOf(spelled).current)).toBeUndefined()
        expect(storedAt(table, keysOf(value).current)?.body).toBe("mine")
      }),
    )

    it.effect(`one Batch.write putting ${spelled} and ${value} writes both`, () =>
      Effect.gen(function* () {
        const table = freshTable()
        // `spelled`'s 1.36 key is `value`'s current key, which the same batch
        // writes: it is not deleted after the puts.
        yield* inTable(
          table,
          Batch.write([Notes.put(note(spelled, "theirs")), Notes.put(note(value, "mine"))]),
        )
        expect(storedAt(table, keysOf(spelled).current)?.body).toBe("theirs")
        expect(storedAt(table, keysOf(value).current)?.body).toBe("mine")
      }),
    )

    it.effect(`transactWrite of ${value} over ${spelled}'s 1.36 row fails ItemNotMoved`, () =>
      Effect.gen(function* () {
        const table = freshTable()
        seed136(table, spelled, "theirs")
        for (const op of [
          Notes.put(note(value, "mine")),
          Notes.delete({ owner: "o", title: value }),
        ]) {
          const err = yield* inTable(table, Transaction.transactWrite([op]).pipe(Effect.flip))
          expect(err._tag).toBe("ItemNotMoved")
          expect((err as { readonly key: unknown }).key).toEqual({ owner: "o", title: spelled })
        }
        expect(storedAt(table, keysOf(spelled).old)?.body).toBe("theirs")
        // A delete of the other leaves this one's current row at its 1.36 key.
        const db = yield* inTable(table, clientOf)
        yield* inTable(table, db.entities.Notes.put(note(value, "mine")).asEffect())
        yield* inTable(
          table,
          Transaction.transactWrite([Notes.delete({ owner: "o", title: spelled })]),
        )
        expect(storedAt(table, keysOf(value).current)?.body).toBe("mine")
      }),
    )

    it.effect(`update and delete of ${value} leave ${spelled}'s 1.36 row alone`, () =>
      Effect.gen(function* () {
        const table = freshTable()
        seed136(table, spelled, "theirs")
        const db = yield* inTable(table, clientOf)
        const key = { owner: "o", title: value }
        const updated = yield* inTable(
          table,
          db.entities.Notes.update(key).set({ body: "hijack" }).asEffect().pipe(Effect.flip),
        )
        expect(updated._tag).toBe("ItemNotFound")
        yield* inTable(table, db.entities.Notes.delete(key).asEffect())
        // Still theirs, wherever it is now.
        const theirs = yield* inTable(
          table,
          db.entities.Notes.get({ owner: "o", title: spelled }).asEffect(),
        )
        expect(theirs.body).toBe("theirs")
      }),
    )

    it.effect(`put and upsert of ${value} move ${spelled}'s 1.36 row out of the way`, () =>
      Effect.gen(function* () {
        for (const write of ["put", "upsert", "create"] as const) {
          const table = freshTable()
          seed136(table, spelled, "theirs")
          const db = yield* inTable(table, clientOf)
          const mine = note(value, "mine")
          yield* inTable(table, db.entities.Notes[write](mine).asEffect())
          // Mine at my key; theirs moved to its own current key, intact.
          expect(storedAt(table, keysOf(value).current)?.body).toBe("mine")
          expect(storedAt(table, keysOf(spelled).current)?.body).toBe("theirs")
          const theirs = yield* inTable(
            table,
            db.entities.Notes.get({ owner: "o", title: spelled }).asEffect(),
          )
          expect(theirs.body).toBe("theirs")
          const got = yield* inTable(
            table,
            db.entities.Notes.get({ owner: "o", title: value }).asEffect(),
          )
          expect(got.body).toBe("mine")
        }
      }),
    )

    it.effect(`writes of ${spelled} leave ${value}'s current row at its 1.36 key`, () =>
      Effect.gen(function* () {
        const writes = {
          put: (db: Effect.Success<typeof clientOf>) =>
            db.entities.Notes.put(note(spelled, "theirs")),
          create: (db: Effect.Success<typeof clientOf>) =>
            db.entities.Notes.create(note(spelled, "theirs")),
          "retained put": (db: Effect.Success<typeof clientOf>) =>
            db.entities.Pages.put(note(spelled, "theirs")),
          "retained create": (db: Effect.Success<typeof clientOf>) =>
            db.entities.Pages.create(note(spelled, "theirs")),
          "retained upsert": (db: Effect.Success<typeof clientOf>) =>
            db.entities.Pages.upsert(note(spelled, "theirs")),
        } as const
        for (const [name, write] of Object.entries(writes)) {
          const table = freshTable()
          const db = yield* inTable(table, clientOf)
          const entity = name.startsWith("retained") ? db.entities.Pages : db.entities.Notes
          yield* inTable(table, entity.put(note(value, "mine")).asEffect())
          yield* inTable(table, write(db).asEffect())
          const keys = name.startsWith("retained") ? pageKeysOf : keysOf
          // Not deleted, nor taken for the item it would be.
          expect([name, storedAt(table, keys(value).current)?.body]).toEqual([name, "mine"])
          expect([name, storedAt(table, keys(spelled).current)?.body]).toEqual([name, "theirs"])
        }
      }),
    )

    it.effect(`restore of ${spelled} leaves ${value}'s current row at its 1.36 key`, () =>
      Effect.gen(function* () {
        const table = freshTable()
        const db = yield* inTable(table, clientOf)
        const key = { owner: "o", title: spelled }
        yield* inTable(table, db.entities.Pages.put(note(spelled, "theirs")).asEffect())
        yield* inTable(table, db.entities.Pages.delete(key).asEffect())
        yield* inTable(table, db.entities.Pages.put(note(value, "mine")).asEffect())
        const restored = yield* inTable(table, db.entities.Pages.restore(key))
        expect(restored.body).toBe("theirs")
        expect(storedAt(table, pageKeysOf(value).current)?.body).toBe("mine")
        expect(storedAt(table, pageKeysOf(spelled).current)?.body).toBe("theirs")
      }),
    )

    it.effect(`${value}'s current row is not ${spelled}'s item at its 1.36 key`, () =>
      Effect.gen(function* () {
        const table = freshTable()
        const db = yield* inTable(table, clientOf)
        yield* inTable(table, db.entities.Notes.put(note(value, "mine")).asEffect())
        const key = { owner: "o", title: spelled }
        const miss = yield* inTable(table, db.entities.Notes.get(key).asEffect().pipe(Effect.flip))
        expect(miss._tag).toBe("ItemNotFound")
        const updated = yield* inTable(
          table,
          db.entities.Notes.update(key).set({ body: "hijack" }).asEffect().pipe(Effect.flip),
        )
        expect(updated._tag).toBe("ItemNotFound")
        yield* inTable(table, db.entities.Notes.delete(key).asEffect())
        expect(storedAt(table, keysOf(value).current)?.body).toBe("mine")
      }),
    )
  }

  it.effect("a guarded put sends one request when the row at its key is its own", () =>
    Effect.gen(function* () {
      const table = freshTable()
      const db = yield* inTable(table, clientOf)
      yield* inTable(table, db.entities.Notes.put(note("foo bar", "v1")).asEffect())
      table.take()
      yield* inTable(
        table,
        db.entities.Notes.put(note("foo bar", "v2")).condition({ body: "v1" }).asEffect(),
      )
      const sent = table.take()
      expect(sent.map((r) => r.command)).toEqual(["PutItem"])
      expect(sent[0]!.input.ConditionExpression).toContain("contains(#al0, :al0)")
      yield* inTable(
        table,
        db.entities.Notes.update({ owner: "o", title: "foo bar" }).set({ body: "v3" }).asEffect(),
      )
      const update = table.take()
      expect(update.map((r) => r.command)).toEqual(["UpdateItem"])
      expect(update[0]!.input.ConditionExpression).toContain("contains(#al0, :al0)")
    }),
  )
})

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

describe("legacy keys — purge of an item 1.36 keyed as another's prefix", () => {
  it.effect("purge of `a b` leaves `a b#c`'s 1.36 row", () =>
    Effect.gen(function* () {
      const table = freshTable()
      seed136(table, "a b", "mine")
      seed136(table, "a b#c", "theirs")
      // The precondition: one item's 1.36 live key prefixes the other's.
      expect(keysOf("a b#c").old.sk!.startsWith(`${keysOf("a b").old.sk}#`)).toBe(true)
      const db = yield* inTable(table, clientOf)
      yield* inTable(table, db.entities.Notes.purge({ owner: "o", title: "a b" }))
      expect(storedAt(table, keysOf("a b").old)).toBeUndefined()
      expect(storedAt(table, keysOf("a b#c").old)?.body).toBe("theirs")
    }),
  )
})

// ---------------------------------------------------------------------------
// The version a retained item starts at
// ---------------------------------------------------------------------------

describe("legacy keys — the version a retained item starts at", () => {
  /** The snapshot key of `version` under the history segment of `liveSk`. */
  const snapshotSk = (liveSk: string, version: number) =>
    DynamoSchema.composeVersionKey(schema, "Page", version, {
      item: KeyComposer.composeHistoryItemSegment(
        schema,
        "Page",
        1,
        Pages.indexes.primary,
        liveSk,
      )!,
    })
  /** The version `title`'s page is at, under its current key. */
  const versionAt = (table: Recording, title: string) =>
    storedAt(table, pageKeysOf(title).current)?.version

  for (const write of ["put", "create"] as const) {
    it.effect(`${write} of \`a%20b\` starts at 1 beside \`a b\`'s versions`, () =>
      Effect.gen(function* () {
        // The precondition: `a%20b`'s 1.36 history prefix is `a b`'s current one.
        expect(pageKeysOf("a%20b").old.sk).toBe(pageKeysOf("a b").current.sk)
        const table = freshTable()
        const db = yield* inTable(table, clientOf)
        for (const body of ["v1", "v2", "v3"]) {
          yield* inTable(table, db.entities.Pages.put(note("a b", body)).asEffect())
        }
        expect(versionAt(table, "a b")).toBe(3)
        yield* inTable(table, db.entities.Pages[write](note("a%20b", "mine")).asEffect())
        expect(versionAt(table, "a%20b")).toBe(1)
        yield* inTable(
          table,
          db.entities.Pages.update({ owner: "o", title: "a%20b" })
            .set({ body: "mine 2" })
            .expectedVersion(1)
            .asEffect(),
        )
        expect(versionAt(table, "a%20b")).toBe(2)
        yield* inTable(table, db.entities.Pages.put(note("a b", "v4")).asEffect())
        expect(versionAt(table, "a b")).toBe(4)
      }),
    )
  }

  it.effect("`a%20b`'s own 1.36 versions count, and `a b` starts past them", () =>
    Effect.gen(function* () {
      const table = freshTable()
      // `a%20b` deleted under 1.36, its versions 1–5 retained under its 1.36 prefix.
      const { pk, sk: liveSk136 } = pageKeysOf("a%20b").old
      for (let version = 1; version <= 5; version++) {
        const sk = snapshotSk(liveSk136!, version)
        table.items.set(at(pk, sk), {
          ...toAttributeMap({ ...note("a%20b", `v${version}`), version, pk, sk }),
          __edd_e__: { S: "Page" },
        })
      }
      const db = yield* inTable(table, clientOf)
      // `a b`'s history prefix holds them: its own snapshots go past them.
      for (const body of ["v6", "v7", "v8"]) {
        yield* inTable(table, db.entities.Pages.put(note("a b", body)).asEffect())
      }
      expect(versionAt(table, "a b")).toBe(8)
      // `a%20b` continues its own history, not `a b`'s.
      yield* inTable(table, db.entities.Pages.create(note("a%20b", "mine")).asEffect())
      expect(versionAt(table, "a%20b")).toBe(6)
      const versions = yield* inTable(
        table,
        db.entities.Pages.versions({ owner: "o", title: "a%20b" }).collect(),
      )
      expect(new Set(versions.map((page) => page.title))).toEqual(new Set(["a%20b"]))
    }),
  )

  /** `title`'s page as 1.36 wrote it at `versions`: live, with a snapshot of each earlier version. */
  const seedRetained136 = (table: Recording, title: string, versions: number) => {
    const { pk, sk } = pageKeysOf(title).old
    for (let version = 1; version < versions; version++) {
      const at136 = snapshotSk(sk!, version)
      table.items.set(at(pk, at136), {
        ...toAttributeMap({ ...note(title, `${title} v${version}`), version, pk, sk: at136 }),
        __edd_e__: { S: "Page" },
      })
    }
    table.items.set(at(pk, sk), {
      ...toAttributeMap({ ...note(title, `${title} v${versions}`), version: versions, pk, sk }),
      __edd_e__: { S: "Page" },
    })
  }

  it.effect("`a b` and `a%20b` each keep the 1.36 history they both hold", () =>
    Effect.gen(function* () {
      const table = freshTable()
      seedRetained136(table, "a%20b", 6)
      seedRetained136(table, "a b", 2)
      const db = yield* inTable(table, clientOf)
      const versionsOf = (title: string) =>
        inTable(
          table,
          db.entities.Pages.versions({ owner: "o", title })
            .collect()
            .pipe(
              // The 1.36 pass is read first (G20): in version order here.
              Effect.map((pages) =>
                pages
                  .map((page) => {
                    // Each snapshot's version, decoded with it.
                    const { version } = page as typeof page & { readonly version: number }
                    return { entry: `${page.body}@${version}`, version }
                  })
                  .sort((a, b) => a.version - b.version)
                  .map(({ entry }) => entry),
              ),
            ),
        )
      // `a b`'s current history prefix holds `a%20b`'s versions 1–5: they are not `a b`'s,
      // and don't hide `a b`'s own version 1 under its 1.36 prefix.
      expect(yield* versionsOf("a b")).toEqual(["a b v1@1"])
      const escaped = ["a%20b v1@1", "a%20b v2@2", "a%20b v3@3", "a%20b v4@4", "a%20b v5@5"]
      expect(yield* versionsOf("a%20b")).toEqual(escaped)

      // Each write of `a b` snapshots a version `a%20b`'s 1.36 history holds at
      // that key: the snapshot there moves to `a%20b`'s current prefix first.
      const page = { owner: "o", title: "a b" }
      yield* inTable(table, db.entities.Pages.put(note("a b", "a b v3")).asEffect())
      yield* inTable(table, db.entities.Pages.update(page).set({ body: "a b v4" }).asEffect())
      yield* inTable(table, db.entities.Pages.delete(page).asEffect())
      yield* inTable(table, db.entities.Pages.restore(page))
      expect(versionAt(table, "a b")).toBeGreaterThan(4)
      const own = yield* versionsOf("a b")
      expect(own.slice(0, 4)).toEqual(["a b v1@1", "a b v2@2", "a b v3@3", "a b v4@4"])
      expect(own.every((entry) => entry.startsWith("a b "))).toBe(true)
      expect(yield* versionsOf("a%20b")).toEqual(escaped)
      // The moved snapshots: `a%20b`'s, under its current history prefix.
      const moved = [...table.items.values()]
        .map((row) => fromAttributeMap(row) as { sk: string; title: string; version?: number })
        .filter((row) =>
          row.sk.startsWith(snapshotSk(pageKeysOf("a%20b").current.sk as string, 1).slice(0, -7)),
        )
      expect(moved.length).toBeGreaterThan(1)
      expect(moved.every((row) => row.title === "a%20b")).toBe(true)
    }),
  )
})

// ---------------------------------------------------------------------------
// History over a string-encoded numeric orderBy
// ---------------------------------------------------------------------------

describe("legacy keys — history over events of both forms under one prefix", () => {
  /** Events 2 and 9 as 1.36 keyed them (`#e#2`), then 10 as 1.37 does. */
  const seeded = (table: Recording) =>
    Effect.gen(function* () {
      const db = yield* inTable(table, clientOf)
      for (const t of [2, 9]) {
        yield* inTable(table, db.entities.Ticks.append({ tickId: 1, at: t, level: t }).asEffect())
      }
      const currentSk = KeyComposer.composeSk(schema, "Tick", 1, Ticks.indexes.primary, {})
      for (const [key, row] of [...table.items.entries()]) {
        const sk = row.sk?.S ?? ""
        if (!sk.startsWith(`${currentSk}#e#`)) continue
        const old = KeyText136.composeEventSk(currentSk, row.at!.S, schema.casing)
        expect(old).not.toBe(sk)
        table.items.delete(key)
        table.items.set(at(row.pk?.S, old), { ...row, sk: { S: old } })
      }
      yield* inTable(table, db.entities.Ticks.append({ tickId: 1, at: 10, level: 10 }).asEffect())
      table.take()
      return db
    })

  it.effect("history reads the 1.36 form first, then the current one; reverse the other way", () =>
    Effect.gen(function* () {
      const table = freshTable()
      const db = yield* seeded(table)
      const key = { tickId: 1 }
      const forward = yield* inTable(table, db.entities.Ticks.history(key).collect())
      expect(forward.map((e) => e.at)).toEqual([2, 9, 10])
      const sent = table.take().filter((r) => r.command === "Query")
      expect(sent).toHaveLength(2)
      const reverse = yield* inTable(table, db.entities.Ticks.history(key).reverse().collect())
      expect(reverse.map((e) => e.at)).toEqual([10, 9, 2])
      // Counted once each.
      expect(yield* inTable(table, db.entities.Ticks.history(key).count())).toBe(3)
    }),
  )

  type Bound = (t: any, ops: any) => any
  const BOUNDS: ReadonlyArray<readonly [string, Bound, ReadonlyArray<number>]> = [
    ["gt 5", (t, { gt }) => gt(t.at, 5), [9, 10]],
    ["gte 9", (t, { gte }) => gte(t.at, 9), [9, 10]],
    ["lt 9", (t, { lt }) => lt(t.at, 9), [2]],
    ["lte 9", (t, { lte }) => lte(t.at, 9), [2, 9]],
    ["lt 10", (t, { lt }) => lt(t.at, 10), [2, 9]],
    ["between 2 and 9", (t, { between }) => between(t.at, 2, 9), [2, 9]],
    ["between 9 and 10", (t, { between }) => between(t.at, 9, 10), [9, 10]],
    ["eq 9", (t, { eq }) => eq(t.at, 9), [9]],
    ["eq 10", (t, { eq }) => eq(t.at, 10), [10]],
    ["beginsWith 2", (t, { beginsWith }) => beginsWith(t.at, 2), [2]],
  ]
  for (const [name, bound, expected] of BOUNDS) {
    it.effect(`.where(${name}) holds on the numbers, forward and reverse`, () =>
      Effect.gen(function* () {
        const table = freshTable()
        const db = yield* seeded(table)
        const key = { tickId: 1 }
        const forward = yield* inTable(table, db.entities.Ticks.history(key).where(bound).collect())
        expect(forward.map((e) => e.at)).toEqual(expected)
        const reverse = yield* inTable(
          table,
          db.entities.Ticks.history(key).where(bound).reverse().collect(),
        )
        expect(reverse.map((e) => e.at)).toEqual([...expected].reverse())
      }),
    )
  }
})
