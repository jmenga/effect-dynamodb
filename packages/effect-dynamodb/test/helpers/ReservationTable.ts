/**
 * Tables of unique sentinels with nothing for `rekey` to move: the rows the published 1.40.0
 * wrote when an item's key was used again after a delete (soft, under `preserveUnique` and
 * without, and hard), over several delete and re-create cycles, and the rows 1.39.0 left
 * (`fixtures/orphaned-reservations-1.39.0.json`). A `rekey` that doesn't ask for
 * `reservations` must send over them the requests 1.40.0 sent, byte for byte
 * (`fixtures/rekey-requests-reservations-1.40.0.json`).
 *
 * No runtime import: the modules come in as arguments, so the generator that wrote the fixture ran
 * this file against the published 1.40.0 and the tests run it against `src/`.
 */

import type { QuietModules } from "./QuietTable.js"

/** {@link QuietModules}, and `effect`'s `Duration`. */
export interface ReservationModules extends QuietModules {
  readonly Duration: any
}

/**
 * The members, under `escapeKeys`: those `fixtures/orphaned-reservations-1.39.0.json` was written
 * by (`Account`, `Member`, `Holder`, `Pass`), on its schema name, and two more whose keys hold a
 * space: `User` (`preserveUnique`) and `Seat` (`preserveUnique`, with a sort key composite).
 */
export const reservationWorld = (m: ReservationModules, escapeKeys: boolean) => {
  const { Schema } = m
  const schema = m.DynamoSchema.make({ name: "vu", version: 1, escapeKeys })
  const Holding = Schema.Struct({ id: Schema.String, n: Schema.BigInt })
  const primaryKey = {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  } as const
  const Accounts = m.Entity.make({
    model: Holding,
    entityType: "Account",
    primaryKey,
    unique: { number: ["n"] },
  })
  const Members = m.Entity.make({
    model: Holding,
    entityType: "Member",
    primaryKey,
    unique: { number: ["n"] },
    softDelete: true,
  })
  const Holders = m.Entity.make({
    model: Holding,
    entityType: "Holder",
    primaryKey,
    unique: { number: ["n"] },
    softDelete: { preserveUnique: true },
  })
  const Passes = m.Entity.make({
    model: Holding,
    entityType: "Pass",
    primaryKey,
    unique: { number: { fields: ["n"], ttl: m.Duration.hours(1) } },
  })
  const Users = m.Entity.make({
    model: Schema.Struct({ id: Schema.String, email: Schema.String }),
    entityType: "User",
    primaryKey,
    unique: { email: ["email"] },
    softDelete: { preserveUnique: true },
  })
  const Seats = m.Entity.make({
    model: Schema.Struct({ venue: Schema.String, seat: Schema.String, n: Schema.BigInt }),
    entityType: "Seat",
    primaryKey: {
      pk: { field: "pk", composite: ["venue"] },
      sk: { field: "sk", composite: ["seat"] },
    },
    unique: { number: ["n"] },
    softDelete: { preserveUnique: true },
  })
  const entities = { Accounts, Members, Holders, Passes, Users, Seats }
  const MainTable = m.Table.make({ schema, entities })
  const client = m.DynamoClient.make({ entities, tables: { MainTable } })
  return { schema, MainTable, client }
}

/**
 * Every member's key used again after a delete, written by the library under `world`'s setting:
 * an item deleted and created again under the same key with another value, once and over several
 * cycles, for each kind of delete; and an item only deleted.
 */
export const writeReusedKeyRows = (
  m: ReservationModules,
  world: ReturnType<typeof reservationWorld>,
) =>
  m.Effect.gen(function* () {
    const db: any = yield* world.client
    const cycle = (entity: any, key: object, values: ReadonlyArray<object>, deleteLast = false) =>
      m.Effect.gen(function* () {
        for (const [i, value] of values.entries()) {
          yield* entity.put({ ...key, ...value }).asEffect()
          if (i < values.length - 1 || deleteLast) yield* entity.delete(key).asEffect()
        }
      })
    const { Users, Holders, Members, Seats, Accounts, Passes } = db.entities
    // The shape of a reused key: deleted under `preserveUnique`, created again with another value.
    yield* cycle(Users, { id: "u1" }, [{ email: "old@x" }, { email: "new@x" }])
    yield* cycle(Users, { id: "u 2" }, [{ email: "a 1@x" }, { email: "a 2@x" }, { email: "a 3@x" }])
    yield* cycle(Users, { id: "u 3" }, [{ email: "b@x" }], true)
    yield* cycle(Holders, { id: "h1" }, [{ n: 31n }, { n: 32n }, { n: 33n }])
    yield* cycle(Seats, { venue: "v 1", seat: "s 1" }, [{ n: 41n }, { n: 42n }])
    // Deletes that release the value: soft without `preserveUnique`, and hard.
    yield* cycle(Members, { id: "m1" }, [{ n: 21n }, { n: 22n }, { n: 23n }])
    yield* cycle(Accounts, { id: "a1" }, [{ n: 51n }, { n: 52n }])
    yield* Passes.put({ id: "p1", n: 61n }).asEffect()
    yield* Passes.update({ id: "p1" }).set({ n: 62n }).asEffect()
  })
