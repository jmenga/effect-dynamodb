/**
 * Every cell of the decision table for a refused write carrying a renamed sparse map's form guard
 * (#238, DESIGN.md §7 "Which verdict a refused write gets"): the caller's condition (none, one that
 * holds, one that doesn't, one only DynamoDB can tell) × what another writer moved between the
 * write's read and its write (nothing, the version, the map's form, both, the form before every
 * attempt) × where the row held the map (whole as `sr`, or as entries), for every write that carries
 * the guard — a transaction's update (Plain, Versioned, Retained, Unique), a retained update, an
 * update that reads the row to clear another map (Plain, Versioned), an update without a read
 * (`expectedVersion` 1 or a stale 5), an upsert without a read (Plain, Versioned) — and a unique
 * entity's upsert, which reads the row and writes the map whole, unguarded.
 *
 * {@link expected} states the table: each cell's outcome, the requests it sends, and what a read
 * takes after. A cell the table answers as 1.40.0 did (the caller's condition false, the version
 * moved, or nothing refused) is also held to `fixtures/renamed-sparse-map-verdict-table-1.40.0.json`:
 * outcome, every request's operation in order, the read and the row.
 *
 * `size(note) = 1` on `"é"` is the condition only DynamoDB can tell (`internal/ConditionHolds.ts`
 * can't: UTF-16 code units say 1, UTF-8 bytes 2). Both DynamoDB Local and the in-memory table count
 * UTF-16 code units, so it holds there.
 */

import { readFileSync } from "node:fs"
import { it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { expect } from "vitest"
import { DynamoClient, type DynamoClientService } from "../../src/DynamoClient.js"
import * as Entity from "../../src/Entity.js"
import * as Table from "../../src/Table.js"
import * as Transaction from "../../src/Transaction.js"
import { type OpenTable, onTable } from "./Kept139.js"

type Captured = {
  readonly outcome: {
    readonly ok?: unknown
    readonly fail?: string
    readonly attributes?: ReadonlyArray<string>
    readonly says?: string
  }
  readonly sent: ReadonlyArray<Record<string, unknown>>
  readonly read: { readonly ok?: { readonly counts: unknown }; readonly fail?: string }
  readonly row: Record<string, unknown>
}

const fixture = JSON.parse(
  readFileSync(
    new URL("../fixtures/renamed-sparse-map-verdict-table-1.40.0.json", import.meta.url),
    "utf8",
  ),
) as { readonly cases: Record<string, Captured> }

const primaryKey = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }

const definitions = () => {
  const model = DynamoModel.configure(
    Schema.Struct({
      id: Schema.String,
      note: Schema.String,
      counts: Schema.Record(Schema.String, Schema.Number),
      tags: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
    }),
    {
      counts: { storedAs: DynamoModel.SparseMap(), field: "sr" },
      tags: { storedAs: DynamoModel.SparseMap() },
    } as never,
  )
  return {
    Plain: Entity.make({ model, entityType: "Plain", primaryKey } as never),
    Versioned: Entity.make({
      model,
      entityType: "Versioned",
      primaryKey,
      versioned: true,
    } as never),
    Retained: Entity.make({
      model,
      entityType: "Retained",
      primaryKey,
      versioned: { retain: true },
    } as never),
    Unique: Entity.make({
      model,
      entityType: "Unique",
      primaryKey,
      unique: { byId: ["id"] },
    } as never),
  } as Record<string, any>
}

const keyOf = (entity: string, id: string) => ({
  pk: { S: `$vt#v1#${entity.toLowerCase()}#id_${id}` },
  sk: { S: `$vt#v1#${entity.toLowerCase()}` },
})

/** The row's map moved to its other form: from `sr` to its entries, or back. */
const reform = (raw: DynamoClientService, tableName: string, entity: string, id: string) =>
  Effect.gen(function* () {
    const row = (yield* raw.getItem({
      TableName: tableName,
      Key: keyOf(entity, id),
      ConsistentRead: true,
    })).Item
    const whole = row?.sr !== undefined
    yield* raw.updateItem({
      TableName: tableName,
      Key: keyOf(entity, id),
      UpdateExpression: whole ? "SET #e = :one REMOVE #w" : "SET #w = :whole REMOVE #e",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#e": "counts#a", "#w": "sr" },
      ExpressionAttributeValues: whole
        ? { ":one": { N: "1" } }
        : { ":whole": { M: { a: { N: "1" } } } },
    })
  })
const bump = (raw: DynamoClientService, tableName: string, entity: string, id: string) =>
  raw.updateItem({
    TableName: tableName,
    Key: keyOf(entity, id),
    UpdateExpression: "SET #v = #v + :one",
    ConditionExpression: "attribute_exists(pk)",
    ExpressionAttributeNames: { "#v": "version" },
    ExpressionAttributeValues: { ":one": { N: "1" } },
  })

type Condition = "none" | "true" | "false" | "unknown"
type Race = "nothing" | "version" | "form" | "version and form" | "form, every attempt"
type Kind = "transaction" | "retained update" | "read update" | "unread" | "whole upsert"

const withCondition = (builder: any, condition: Condition) =>
  condition === "none"
    ? builder
    : builder.condition((t: any, ops: any) =>
        condition === "true"
          ? ops.eq(t.note, "é")
          : condition === "false"
            ? ops.eq(t.note, "no")
            : ops.eq(t.note.size(), 1),
      )

/** Each write: [subject, entity, kind, the write]. In the capture's order: ids follow it. */
const subjects: ReadonlyArray<
  readonly [
    subject: string,
    entity: string,
    kind: Kind,
    /** Run inside `onTable`'s body, which provides the client and the table (a transaction). */
    write: (db: any, id: string, condition: Condition) => Effect.Effect<unknown, unknown, any>,
  ]
> = [
  [
    "a transaction's update",
    "Versioned",
    "transaction",
    (db, id, c) =>
      Transaction.transactWrite([
        withCondition(db.entities.Versioned.update({ id }).set({ counts: { b: 2 } }), c),
      ]),
  ],
  [
    "a transaction's update",
    "Plain",
    "transaction",
    (db, id, c) =>
      Transaction.transactWrite([
        withCondition(db.entities.Plain.update({ id }).set({ counts: { b: 2 } }), c),
      ]),
  ],
  [
    "a transaction's update",
    "Retained",
    "transaction",
    (db, id, c) =>
      Transaction.transactWrite([
        withCondition(
          db.entities.Retained.update({ id }).pathAdd({ segments: ["counts#b"], value: 2 }),
          c,
        ),
      ]),
  ],
  [
    "an update",
    "Retained",
    "retained update",
    (db, id, c) =>
      withCondition(
        db.entities.Retained.update({ id }).pathAdd({ segments: ["counts#b"], value: 2 }),
        c,
      ).asEffect(),
  ],
  [
    "an upsert",
    "Versioned",
    "unread",
    (db, id, c) =>
      withCondition(
        db.entities.Versioned.upsert({ id, note: "é", counts: { b: 2 } }),
        c,
      ).asEffect(),
  ],
  [
    "an upsert",
    "Unique",
    "whole upsert",
    (db, id, c) =>
      withCondition(db.entities.Unique.upsert({ id, note: "é", counts: { b: 2 } }), c).asEffect(),
  ],
  [
    "a transaction's update",
    "Unique",
    "transaction",
    (db, id, c) =>
      Transaction.transactWrite([
        withCondition(db.entities.Unique.update({ id }).set({ counts: { b: 2 } }), c),
      ]),
  ],
  [
    "an update clearing another map",
    "Versioned",
    "read update",
    (db, id, c) =>
      withCondition(
        db.entities.Versioned.update({ id })
          .clearMap("tags")
          .set({ counts: { b: 2 } }),
        c,
      ).asEffect(),
  ],
  [
    "an update clearing another map",
    "Plain",
    "read update",
    (db, id, c) =>
      withCondition(
        db.entities.Plain.update({ id })
          .clearMap("tags")
          .set({ counts: { b: 2 } }),
        c,
      ).asEffect(),
  ],
  [
    "an update, expectedVersion(1)",
    "Versioned",
    "unread",
    (db, id, c) =>
      withCondition(
        db.entities.Versioned.update({ id })
          .set({ counts: { b: 2 } })
          .expectedVersion(1),
        c,
      ).asEffect(),
  ],
  [
    "an update, expectedVersion(5)",
    "Versioned",
    "unread",
    (db, id, c) =>
      withCondition(
        db.entities.Versioned.update({ id })
          .set({ counts: { b: 2 } })
          .expectedVersion(5),
        c,
      ).asEffect(),
  ],
  [
    "an upsert",
    "Plain",
    "unread",
    (db, id, c) =>
      withCondition(db.entities.Plain.upsert({ id, note: "é", counts: { b: 2 } }), c).asEffect(),
  ],
]
const CONDITIONS: ReadonlyArray<Condition> = ["none", "true", "false", "unknown"]

type Cell = {
  readonly label: string
  readonly id: string
  readonly subject: string
  readonly entity: string
  readonly kind: Kind
  readonly write: (
    db: any,
    id: string,
    condition: Condition,
  ) => Effect.Effect<unknown, unknown, any>
  readonly condition: Condition
  readonly from: "whole" | "entries"
  readonly race: Race
  /** Whether the write reads the row before it writes (and so is raced). */
  readonly reads: boolean
}

const cells: ReadonlyArray<Cell> = (() => {
  const all: Array<Cell> = []
  for (const [subject, entity, kind, write] of subjects) {
    // The capture's subjects that read the row first: every write but an unread one.
    const reads = kind !== "unread" || (subject === "an upsert" && entity === "Versioned")
    for (const condition of CONDITIONS) {
      for (const from of ["whole", "entries"] as const) {
        const races: ReadonlyArray<Race> = !reads
          ? ["nothing"]
          : entity === "Plain" || entity === "Unique"
            ? ["nothing", "form", "form, every attempt"]
            : ["nothing", "version", "form", "version and form", "form, every attempt"]
        for (const race of races) {
          const label =
            `${entity}, ${subject}, condition ${condition}, the map ${from}` +
            (reads ? `, moved before the write: ${race}` : "")
          all.push({
            label,
            id: `c${all.length}`,
            subject,
            entity,
            kind,
            write,
            condition,
            from,
            race,
            reads,
          })
        }
      }
    }
  }
  return all
})()

type Expected = {
  readonly outcome: "ok" | "OptimisticLockError" | "ConcurrentModification" | string
  /** The map an error names (`attributes`), or none. */
  readonly attributes?: ReadonlyArray<string>
  /** A diagnostic code the error says. */
  readonly code?: string
  readonly requests: number
  /** Answered as 1.40.0 answered it: the cell equals the fixture's. */
  readonly as140: boolean
}

const WRITTEN = { a: 1, b: 2 }
const SEEDED = { a: 1 }

/**
 * The decision table (DESIGN.md §7 "Which verdict a refused write gets"), cell by cell.
 *
 * A write that reads the row: the caller's condition false on the row returned → the caller's error
 * (`TransactionCancelled` / `ConditionalCheckFailed`) at once, as 1.40.0; the version it read moved
 * → the version's verdict, as 1.40.0 (a transaction plans again, a retained update fails
 * `OptimisticLockError`); otherwise the form changed → read again and written again (a condition the
 * evaluator can't tell is judged by DynamoDB on that second write), and a form changed before every
 * attempt → the race, naming the map. A write that doesn't read the row, to a row holding the map
 * whole → `EDD-9150` where the rest of its condition is known to hold, else the rest's verdict (a
 * condition the evaluator can't tell is answered as the caller's).
 */
const expected = (cell: Cell): Expected => {
  const versioned = cell.entity === "Versioned" || cell.entity === "Retained"
  const callers = cell.kind === "transaction" ? "TransactionCancelled" : "ConditionalCheckFailed"
  if (cell.kind === "whole upsert") {
    return cell.condition === "false"
      ? { outcome: callers, requests: 2, as140: true }
      : { outcome: "ok", requests: 2, as140: false }
  }
  if (cell.kind === "unread") {
    if (cell.subject.endsWith("expectedVersion(5)")) {
      return { outcome: "OptimisticLockError", requests: 1, as140: true }
    }
    // An unread write: the race moves the map once, just before it.
    const raced = cell.race !== "nothing" && cell.race !== "version"
    const whole = (cell.from === "whole") !== raced
    if (cell.condition === "false") return { outcome: callers, requests: 1, as140: true }
    if (!whole) return { outcome: "ok", requests: 1, as140: true }
    return cell.condition === "unknown"
      ? { outcome: callers, requests: 1, as140: false }
      : { outcome: "ValidationError", code: "EDD-9150", requests: 1, as140: false }
  }
  const versionMoves = cell.race === "version" || cell.race === "version and form"
  const formMoves = cell.race !== "nothing" && cell.race !== "version"
  // Which writes the version refuses: a retained one is guarded on the version it read.
  const versionRefuses = cell.entity === "Retained"
  if (cell.kind === "retained update" || cell.kind === "read update") {
    // A retained update reads its new item back once written.
    const after = cell.kind === "retained update" ? 1 : 0
    if (versionMoves) return { outcome: "OptimisticLockError", requests: 2, as140: true }
    if (cell.condition === "false") return { outcome: callers, requests: 2, as140: true }
    if (!formMoves) return { outcome: "ok", requests: 2 + after, as140: false }
    if (cell.race === "form, every attempt") {
      return {
        outcome: versioned ? "OptimisticLockError" : "ConcurrentModification",
        attributes: ["counts"],
        requests: 6,
        as140: false,
      }
    }
    return { outcome: "ok", requests: 4 + after, as140: false }
  }
  // A transaction: planned again on a lost race, the second plan unraced.
  if (cell.condition === "false") {
    // The version moved and the caller's condition fails: planned again, as 1.40.0.
    return {
      outcome: callers,
      requests: versionMoves && versioned ? 4 : 2,
      as140: true,
    }
  }
  if (versionMoves && versionRefuses) return { outcome: "ok", requests: 4, as140: false }
  if (!formMoves) return { outcome: "ok", requests: 2, as140: false }
  if (cell.race === "form, every attempt") {
    return {
      outcome: versioned ? "OptimisticLockError" : "ConcurrentModification",
      attributes: ["counts"],
      requests: 6,
      as140: false,
    }
  }
  return { outcome: "ok", requests: 4, as140: false }
}

const WRITES = new Set(["updateItem", "putItem", "transactWriteItems", "deleteItem"])

/**
 * `open`'s table, whose client runs `state.race` just before a write sent while `state.armed` is
 * set (before the first only, unless `state.every`), and logs every operation sent while it is.
 */
const racing =
  (
    open: OpenTable,
    state: {
      armed: boolean
      every: boolean
      fired: number
      race:
        | ((raw: DynamoClientService, tableName: string) => Effect.Effect<unknown, unknown>)
        | undefined
      log: Array<string>
    },
  ): OpenTable =>
  (MainTable) =>
    Effect.map(open(MainTable), (table) => ({
      ...table,
      layer: Layer.effect(
        DynamoClient,
        Effect.gen(function* () {
          const client = yield* DynamoClient
          return Object.fromEntries(
            Object.entries(client).map(([name, operation]) => [
              name,
              typeof operation === "function"
                ? (input: unknown) =>
                    Effect.suspend(() => {
                      if (!state.armed) return operation.call(client, input)
                      state.log.push(name)
                      const sent = operation.call(client, input)
                      if (!WRITES.has(name) || state.race === undefined) return sent
                      if (!state.every && state.fired > 0) return sent
                      state.fired++
                      return Effect.andThen(Effect.orDie(state.race(client, table.name)), sent)
                    })
                : operation,
            ]),
          ) as unknown as DynamoClientService
        }),
      ).pipe(Layer.provide(table.layer)),
    }))

const outcomeOf = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return { ok: true as const }
  const error = Cause.squash(exit.cause) as {
    _tag?: string
    attributes?: ReadonlyArray<string>
    cause?: unknown
    message?: string
  }
  return {
    fail: error._tag ?? String(error),
    attributes: error.attributes,
    says: String(error.cause ?? error.message ?? ""),
  }
}

const scrubbed = (row: Record<string, unknown> | undefined) =>
  row === undefined
    ? undefined
    : JSON.parse(
        JSON.stringify(row).replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
          "<token>",
        ),
      )

export const renamedSparseMapVerdictTableSuite = (open: OpenTable) => {
  it("the fixture captures every cell of the table, and nothing else", () => {
    expect(Object.keys(fixture.cases).sort()).toEqual(cells.map((cell) => cell.label).sort())
  })

  for (const cell of cells) {
    const want = expected(cell)
    const was = fixture.cases[cell.label]!
    it.effect(
      `${cell.label}: ${want.outcome}${want.attributes ? ` naming ${want.attributes}` : ""}${want.code ? ` (${want.code})` : ""}, ${want.requests} request(s)${want.as140 ? ", as 1.40.0" : ""}`,
      () =>
        Effect.gen(function* () {
          const entities = definitions()
          const MainTable = Table.make({
            schema: DynamoSchema.make({ name: "vt", version: 1 }),
            entities,
          } as never)
          const state = {
            armed: false,
            every: false,
            fired: 0,
            race: undefined as
              | ((raw: DynamoClientService, tableName: string) => Effect.Effect<unknown, unknown>)
              | undefined,
            log: [] as Array<string>,
          }
          const got = yield* onTable(racing(open, state), 0, MainTable, { entities }, (db, table) =>
            Effect.gen(function* () {
              const raw = yield* DynamoClient
              yield* db.entities[cell.entity]
                .put({ id: cell.id, note: "é", counts: { a: 1 } })
                .asEffect()
              if (cell.from === "entries") yield* reform(raw, table.name, cell.entity, cell.id)
              state.race =
                cell.race === "nothing"
                  ? undefined
                  : cell.race === "version"
                    ? (client, name) => bump(client, name, cell.entity, cell.id)
                    : cell.race === "version and form"
                      ? (client, name) =>
                          Effect.andThen(
                            bump(client, name, cell.entity, cell.id),
                            reform(client, name, cell.entity, cell.id),
                          )
                      : (client, name) => reform(client, name, cell.entity, cell.id)
              state.every = cell.race === "form, every attempt"
              state.armed = true
              const exit = yield* Effect.exit(
                Effect.suspend(() => cell.write(db, cell.id, cell.condition)),
              )
              state.armed = false
              const read = yield* db.entities[cell.entity].get({ id: cell.id })
              const row = (yield* raw.getItem({
                TableName: table.name,
                Key: keyOf(cell.entity, cell.id),
                ConsistentRead: true,
              })).Item
              return { exit, read, row, log: [...state.log] }
            }),
          )
          const outcome = outcomeOf(got.exit)
          if (want.outcome === "ok") {
            expect(outcome).toEqual({ ok: true })
            expect(got.read.counts).toEqual(WRITTEN)
          } else {
            expect(outcome.fail).toBe(want.outcome)
            expect(outcome.attributes).toEqual(want.attributes)
            if (want.code !== undefined) expect(outcome.says).toContain(`[${want.code}]`)
            // Nothing written: the row reads as seeded.
            expect(got.read.counts).toEqual(SEEDED)
          }
          expect(got.log).toHaveLength(want.requests)
          if (want.as140) {
            expect(outcome.fail).toBe(was.outcome.fail)
            expect(got.log).toEqual(was.sent.map((request) => Object.keys(request)[0]))
            expect(got.read.counts).toEqual(was.read.ok?.counts)
            expect(scrubbed(got.row)).toEqual(was.row)
          }
        }),
    )
  }
}
