/**
 * Effect's look-alike types as key composites (#242 §2): `Duration`, `BigDecimal`, the `TimeZone`
 * family, `UrlParams`, `SemVer`, `SemVerRange`, the network and DNS types, and a `DateTime` inside an
 * `Option` or a `Result`. DynamoDB hands each back as a map; published 1.39.0 composed a key from
 * the value given (its text, `1500 millis`), but a key composed again from a row read back held the
 * map's text, `[object object]`: `restore` put the item back under a key `put` never wrote, and a
 * delete left the unique-constraint sentinel `put` wrote. Published 1.40.0 refused these composites
 * at write (EDD-9128). Now a row read back hands the field back as the instance written, so a key
 * composed again from it is `put`'s text, and the refusal is lifted for every kind but a cookie and
 * a jar of them, which stay refused.
 *
 * The rows are published 1.39.0's own (`fixtures/lookalike-keys-1.39.0.json`): the head writes them
 * byte for byte, finds them, restores a 1.39.0 tombstone under the key `put` wrote, releases a
 * 1.39.0 sentinel, and `rekey` finds every one where it belongs. Measured with published 1.40.0 on
 * the same rows: `get` found them, but `restore` composed `[object object]`, a unique delete left
 * the sentinel, and `rekey` skipped five of the seven rows as keys it didn't recognise.
 */
import { it } from "@effect/vitest"
import { DateTime, Effect, Exit, Option, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import {
  asHeadLeavesIt,
  comparable,
  definitionsOf,
  fixture,
  isCookie,
  keysOf,
  kindOf,
  putAll,
  type Row,
  restoreAndUpdate,
  typed,
  written,
} from "./helpers/LookalikeKeys.js"
import { isInstanceOf, lookalikes } from "./helpers/Lookalikes.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

/** A table holding `seed`, and a typed client of the fixture's definitions on it. */
const on = <A>(
  field: Schema.Top,
  seed: ReadonlyArray<Row>,
  body: (db: any, rows: () => ReadonlyArray<Row>) => Effect.Effect<A, unknown, any>,
) => {
  const { Soft, Unique, Indexed, Retained, Roots, Base, Main } = definitionsOf(field)
  const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
  for (const row of seed)
    table.items.set(`${row.pk!.S}|${row.sk!.S}`, structuredClone(row) as never)
  const rows = () => [...table.items.values()] as unknown as ReadonlyArray<Row>
  return Effect.gen(function* () {
    const db = yield* DynamoClient.make({
      entities: { Soft, Unique, Indexed, Retained },
      aggregates: { Roots },
      tables: { Main },
    } as never) as Effect.Effect<any, never, any>
    return yield* body(db, rows)
  }).pipe(Effect.provide(Base.layer({ name: "t" })), Effect.provide(table.layer)) as Effect.Effect<
    A,
    unknown
  >
}

describe("look-alike key composites, against the rows published 1.39.0 wrote", () => {
  it("the fixture covers each type and 1.39.0's restore composed the map's text", () => {
    expect(written.map(([name]) => name)).toHaveLength(33)
    for (const [, captured] of written) {
      expect(keysOf(typed(captured.stages.restored, "Soft"))).toEqual([
        "$keys#v1#soft#id_a|$keys#v1#soft#f_[object object]",
      ])
      // The unique delete left the sentinel the put wrote.
      expect(typed(captured.stages.updated, "Unique._unique.")).toHaveLength(1)
    }
  })

  for (const [name, captured] of written) {
    const { field, make } = kindOf(name)

    it.effect(`${name}: put, delete, restore and update store 1.39.0's rows`, () =>
      on(field, [], (db, rows) =>
        Effect.gen(function* () {
          yield* putAll(db, make)
          expect(comparable(rows())).toEqual(comparable(captured.stages.put))
          const stages = yield* restoreAndUpdate(db, rows, make)
          expect(comparable(stages.softDeleted)).toEqual(comparable(captured.stages.softDeleted))
          for (const stage of ["restored", "updated"] as const) {
            expect(comparable(stages[stage])).toEqual(comparable(asHeadLeavesIt(captured, stage)))
          }
        }),
      ),
    )

    it.effect(`${name}: 1.39.0's rows are found, and restored and updated as the head's own`, () =>
      on(field, captured.stages.put, (db, rows) =>
        Effect.gen(function* () {
          const got = yield* db.entities.Soft.get({ id: "a", f: make() })
          expect(isInstanceOf(got.f, make(), field)).toBe(true)
          expect(yield* db.entities.Indexed.byF({ f: make() }).collect()).toHaveLength(1)
          const root = yield* db.aggregates.Roots.get({ id: "e", f: make() })
          expect(root.note).toBe("one")
          const stages = yield* restoreAndUpdate(db, rows, make)
          expect(comparable(stages.softDeleted)).toEqual(comparable(captured.stages.softDeleted))
          for (const stage of ["restored", "updated"] as const) {
            expect(comparable(stages[stage])).toEqual(comparable(asHeadLeavesIt(captured, stage)))
          }
        }),
      ),
    )

    it.effect(`${name}: a 1.39.0 tombstone is restored under the key put wrote`, () =>
      on(field, captured.stages.softDeleted, (db, rows) =>
        Effect.gen(function* () {
          yield* db.entities.Soft.restore({ id: "a", f: make() })
          expect(comparable(typed(rows(), "Soft"))).toEqual(
            comparable(typed(captured.stages.put, "Soft")),
          )
          yield* db.entities.Soft.get({ id: "a", f: make() })
        }),
      ),
    )

    it.effect(`${name}: rekey finds 1.39.0's rows where they belong and moves nothing`, () =>
      on(field, captured.stages.put, (db, rows) =>
        Effect.gen(function* () {
          const report = yield* db.tables.Main.rekey()
          expect(report.scanned).toBe(captured.stages.put.length)
          expect(Object.values(report.moved).every((n) => n === 0)).toBe(true)
          expect(Object.values(report.skipped).every((n) => n === 0)).toBe(true)
          expect(report.indexKeys.lagging).toBe(0)
          expect(report.indexKeysRewritten).toBe(0)
          expect(report.sentinelsMoved).toBe(0)
          expect(report.conflicts).toEqual([])
          expect(comparable(rows())).toEqual(comparable(captured.stages.put))
        }),
      ),
    )

    // 1.39.0's restore wrote the item under a key `put` never wrote: its stored values compose
    // another one, so `rekey` doesn't take that key for the item's, and reports the row.
    it.effect(
      `${name}: rekey leaves the row 1.39.0's restore keyed by the map, and reports it`,
      () =>
        on(field, captured.stages.restored, (db, rows) =>
          Effect.gen(function* () {
            const report = yield* db.tables.Main.rekey()
            expect(report.skipped.unrecognizedKey).toBe(1)
            expect(Object.values(report.moved).every((n) => n === 0)).toBe(true)
            expect(report.conflicts).toEqual([])
            expect(comparable(rows())).toEqual(comparable(captured.stages.restored))
          }),
        ),
    )
  }

  for (const name of ["BigDecimal", "BigDecimal past 2^53"]) {
    const { field, make } = kindOf(name)
    it.effect(`${name}: 1.39.0's put died; the head keys it by the value's text`, () =>
      on(field, [], (db, rows) =>
        Effect.gen(function* () {
          expect(fixture[name]!.results.put).toMatchObject({
            Soft: { tag: "defect", says: "Maximum call stack size exceeded" },
          })
          yield* putAll(db, make)
          const text = String(make()).toLowerCase()
          expect(keysOf(rows())).toEqual(
            [
              "$keys#v1#indexed#id_c|$keys#v1#indexed",
              `$keys#v1#retained#id_d|$keys#v1#retained#v#f_${text}#0000001`,
              `$keys#v1#retained#id_d|$keys#v1#retained#f_${text}`,
              `$keys#v1#roots#e#${text}|$keys#v1#root`,
              `$keys#v1#soft#id_a|$keys#v1#soft#f_${text}`,
              "$keys#v1#unique#id_b|$keys#v1#unique",
              `$keys#v1#unique.byf#${text}|$keys#v1#unique.byf`,
            ].sort(),
          )
          expect(typed(rows(), "Indexed")[0]!.gsi1pk).toEqual({ S: `$keys#v1#indexed#f_${text}` })
          const stages = yield* restoreAndUpdate(db, rows, make)
          expect(keysOf(typed(stages.restored, "Soft"))).toEqual([
            `$keys#v1#soft#id_a|$keys#v1#soft#f_${text}`,
          ])
          expect(typed(stages.updated, "Unique")).toEqual([])
        }),
      ),
    )
  }
})

describe("cookies stay refused as key composites", () => {
  for (const name of ["Cookie", "Cookie expires", "Cookies"]) {
    const { field, make } = kindOf(name)
    const captured = fixture[name]!

    it.effect(`${name}: put and create are refused with EDD-9128, as on 1.40.0`, () =>
      on(field, [], (db, rows) =>
        Effect.gen(function* () {
          for (const exit of [
            yield* Effect.exit(db.entities.Soft.put({ id: "a", f: make() }).asEffect()),
            yield* Effect.exit(db.entities.Unique.put({ id: "b", f: make() }).asEffect()),
            yield* Effect.exit(db.entities.Indexed.put({ id: "c", f: make() }).asEffect()),
            yield* Effect.exit(db.aggregates.Roots.create({ id: "e", f: make(), note: "one" })),
          ]) {
            expect(Exit.isFailure(exit)).toBe(true)
            const text = JSON.stringify(exit)
            expect(text).toContain("ValidationError")
            expect(text).toContain("EDD-9128")
          }
          expect(rows()).toEqual([])
        }),
      ),
    )

    it.effect(`${name}: 1.39.0's rows are still found by the key put composed`, () =>
      on(field, captured.stages.put, (db) =>
        Effect.gen(function* () {
          yield* db.entities.Soft.get({ id: "a", f: make() })
          expect(yield* db.entities.Indexed.byF({ f: make() }).collect()).toHaveLength(1)
        }),
      ),
    )
  }
})

describe("every look-alike kind but cookies keys an item through restore and release", () => {
  for (const { name, field, make } of lookalikes.filter((kind) => !isCookie(kind.name))) {
    it.effect(`${name}: restore and a sentinel's release use the key put wrote`, () =>
      on(field, [], (db, rows) =>
        Effect.gen(function* () {
          yield* db.entities.Soft.put({ id: "a", f: make() }).asEffect()
          yield* db.entities.Unique.put({ id: "b", f: make() }).asEffect()
          const put = keysOf(rows())
          const text = String(make()).toLowerCase()
          expect(put).toContain(`$keys#v1#soft#id_a|$keys#v1#soft#f_${text}`)
          expect(put).toContain(`$keys#v1#unique.byf#${text}|$keys#v1#unique.byf`)
          yield* db.entities.Soft.delete({ id: "a", f: make() }).asEffect()
          yield* db.entities.Soft.restore({ id: "a", f: make() })
          expect(keysOf(typed(rows(), "Soft"))).toEqual([
            `$keys#v1#soft#id_a|$keys#v1#soft#f_${text}`,
          ])
          const got = yield* db.entities.Soft.get({ id: "a", f: make() })
          expect(isInstanceOf(got.f, make(), field)).toBe(true)
          yield* db.entities.Unique.delete({ id: "b" }).asEffect()
          expect(typed(rows(), "Unique")).toEqual([])
          // The value is free again.
          yield* db.entities.Unique.put({ id: "c", f: make() }).asEffect()
        }),
      ),
    )
  }

  it.effect("a DateTime in an Option keys by the value's text, as 1.39.0 did", () =>
    on(Schema.Option(Schema.DateTimeUtc), [], (db, rows) =>
      Effect.gen(function* () {
        yield* db.entities.Soft.put({
          id: "a",
          f: Option.some(DateTime.makeUnsafe("2025-01-01T00:00:00.000Z")),
        }).asEffect()
        expect(keysOf(rows())).toEqual([
          "$keys#v1#soft#id_a|$keys#v1#soft#f_some(datetime.utc(2025-01-01t00:00:00.000z))",
        ])
      }),
    ),
  )
})
