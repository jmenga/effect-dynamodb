/**
 * A query operand its composite's kind can't hold exactly (`EDD-9050`): a `bigint` past 2^53 for a
 * number, a fraction for a bigint, plain or string-encoded. It has no key text, and is refused as a
 * value is (`NaN`, `EDD-9096`): the query fails with a `ValidationError` on its error channel and
 * sends nothing. Building the condition has no error channel, so the refusal used to escape it as a
 * thrown `Error` and the query died.
 */

import { it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Exit, Schema } from "effect"
import { describe, expect } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import * as Collection from "../src/Collection.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as EventStore from "../src/EventStore.js"
import * as Expression from "../src/Expression.js"
import * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const kinds = [
  { name: "Schema.Number", Kind: Schema.Number, inexact: 9007199254740993n, kind: "number" },
  { name: "Schema.BigInt", Kind: Schema.BigInt, inexact: 1.5, kind: "bigint" },
  {
    name: "Schema.NumberFromString",
    Kind: Schema.NumberFromString,
    inexact: 9007199254740993n,
    kind: "number",
  },
  { name: "Schema.BigIntFromString", Kind: Schema.BigIntFromString, inexact: -1.5, kind: "bigint" },
] as const

const definitions = (Kind: Schema.Top, escapeKeys: boolean) => {
  const schema = DynamoSchema.make({ name: "inexact", version: 1, escapeKeys })
  const model = Schema.Struct({ id: Schema.String, n: Kind })
  const E = Entity.make({
    model,
    entityType: "E",
    primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
    indexes: {
      byN: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["id"] },
        sk: { field: "gsi1sk", composite: ["n"] },
      },
      byKey: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["n"] },
        sk: { field: "gsi2sk", composite: ["id"] },
      },
    },
    timeSeries: { orderBy: "n", appendInput: model },
  } as never) as any
  const Main = Table.make({ schema, entities: { E } } as never) as any
  return { E, Main }
}

const conditions = {
  eq: (n: unknown) => (t: any, ops: any) => ops.eq(t.n, n),
  gte: (n: unknown) => (t: any, ops: any) => ops.gte(t.n, n),
  between: (n: unknown) => (t: any, ops: any) => ops.between(t.n, n, n),
} as const

describe("a query operand its composite's kind can't hold exactly fails, sending nothing", () => {
  for (const { name, Kind, inexact, kind } of kinds) {
    for (const escapeKeys of [false, true]) {
      const run = (query: (e: any) => any) => {
        const { E, Main } = definitions(Kind, escapeKeys)
        const table = makeRecordingTable({
          indexes: {
            gsi1: { pk: "gsi1pk", sk: "gsi1sk" },
            gsi2: { pk: "gsi2pk", sk: "gsi2sk" },
          },
        })
        return Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { E },
            tables: { Main },
          } as never) as Effect.Effect<any, never, any>
          const exit = yield* Effect.exit(Effect.suspend(() => query(db.entities.E).collect()))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const failure = exit.cause.reasons[0]!
            // On the error channel: a failure, not a defect.
            expect(failure._tag).toBe("Fail")
            const error = Cause.squash(exit.cause) as any
            expect(error._tag).toBe("ValidationError")
            expect(String(error.cause?.message)).toContain(`[EDD-9050] Composite "n"`)
            expect(String(error.cause?.message)).toContain(`is a value no ${kind} holds exactly`)
          }
          expect(table.requests).toEqual([])
        }).pipe(
          Effect.provide(Main.layer({ name: "t" })),
          Effect.provide(table.layer),
        ) as Effect.Effect<void, unknown>
      }

      for (const [op, condition] of Object.entries(conditions)) {
        it.effect(`${name}, escapeKeys ${escapeKeys}: history ${op}`, () =>
          run((e) => e.history({ id: "x" }).where(condition(inexact))),
        )
        it.effect(`${name}, escapeKeys ${escapeKeys}: index ${op}`, () =>
          run((e) => e.byN({ id: "x" }).where(condition(inexact))),
        )
      }

      it.effect(`${name}, escapeKeys ${escapeKeys}: an index's partition key composite`, () =>
        run((e) => e.byKey({ n: inexact })),
      )
    }
  }
})

describe("a standalone collection's query and selectors fail on an inexact operand, sending nothing", () => {
  for (const { name, Kind, inexact, kind } of kinds) {
    for (const escapeKeys of [false, true]) {
      const run = (query: (c: any) => Query.Query<unknown>) => {
        const schema = DynamoSchema.make({ name: "inexactc", version: 1, escapeKeys })
        const E = Entity.make({
          model: Schema.Struct({ id: Schema.String, n: Kind }),
          entityType: "E",
          primaryKey: {
            pk: { field: "pk", composite: ["id"] },
            sk: { field: "sk", composite: [] },
          },
          indexes: {
            byN: {
              name: "gsi1",
              collection: "Together",
              pk: { field: "gsi1pk", composite: ["n"] },
              sk: { field: "gsi1sk", composite: [] },
            },
          },
        } as never) as any
        const Main = Table.make({ schema, entities: { E } } as never) as any
        const Together = Collection.make("Together", { E } as never) as any
        const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
        return Effect.gen(function* () {
          yield* DynamoClient.make({ entities: { E }, tables: { Main } } as never) as Effect.Effect<
            any,
            never,
            any
          >
          const exit = yield* Effect.exit(Effect.suspend(() => Query.collect(query(Together))))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons[0]!._tag).toBe("Fail")
            const error = Cause.squash(exit.cause) as any
            expect(error._tag).toBe("ValidationError")
            expect(String(error.cause?.message)).toContain(`is a value no ${kind} holds exactly`)
          }
          expect(table.requests).toEqual([])
        }).pipe(
          Effect.provide(Main.layer({ name: "t" })),
          Effect.provide(table.layer),
        ) as Effect.Effect<void, unknown>
      }
      it.effect(`${name}, escapeKeys ${escapeKeys}: query`, () =>
        run((c) => c.query({ n: inexact })),
      )
      it.effect(`${name}, escapeKeys ${escapeKeys}: a member's selector`, () =>
        run((c) => c.E({ n: inexact })),
      )
    }
  }
})

describe("an aggregate's delete reports an inexact key as it reports any key it can't compose", () => {
  // `delete`'s errors have no `ValidationError`: a key it can't compose is an
  // `AggregateAssemblyError`, and nothing is sent.
  for (const { name, Kind, inexact } of kinds) {
    for (const escapeKeys of [false, true]) {
      it.effect(`${name}, escapeKeys ${escapeKeys}`, () => {
        const schema = DynamoSchema.make({ name: "inexacta", version: 1, escapeKeys })
        const Main = Table.make({ schema, entities: {} } as never) as any
        const A = (Aggregate.make as any)(Schema.Struct({ n: Kind, note: Schema.String }), {
          table: Main,
          schema,
          pk: { field: "pk", composite: ["n"] },
          collection: { name: "roots" },
          root: { entityType: "Root" },
          edges: {},
        })
        const table = makeRecordingTable()
        return Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: {},
            aggregates: { A },
            tables: { Main },
          } as never) as Effect.Effect<any, never, any>
          const exit = yield* Effect.exit(db.aggregates.A.delete({ n: inexact }))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons[0]!._tag).toBe("Fail")
            const error = Cause.squash(exit.cause) as any
            expect(error._tag).toBe("AggregateAssemblyError")
            expect(String(error.reason)).toContain("EDD-9050")
          }
          expect(table.requests).toEqual([])
        }).pipe(
          Effect.provide(Main.layer({ name: "t" })),
          Effect.provide(table.layer),
        ) as Effect.Effect<void, unknown>
      })
    }
  }
})

describe("a transaction refuses an op's inexact key, or a put its schema refuses, before any op reads", () => {
  // Every op is checked and composed before the first read of any op: a guarded
  // put, a retain put or a planned update reads first, and used to read before
  // another op's key was found to have no text, or its put item refused. The
  // put's value is refused by its schema (`Expected number`), the delete's and
  // the check's key by its composite's kind (`EDD-9050`).
  const transactions = ["Transaction.transactWrite", "EventStore.append"] as const
  const guards = ["a unique put", "a retain put", "a unique update"] as const
  const bads = ["delete", "check", "put"] as const
  for (const path of transactions) {
    for (const guard of guards) {
      // An EventStore append's additional items carry no updates.
      if (path === "EventStore.append" && guard === "a unique update") continue
      for (const bad of bads) {
        for (const first of [false, true]) {
          it.effect(`${path}: a ${bad} ${first ? "before" : "after"} ${guard}`, () => {
            const schema = DynamoSchema.make({ name: "inexactt", version: 1 })
            const E = Entity.make({
              model: Schema.Struct({ id: Schema.String, n: Schema.Number }),
              entityType: "E",
              primaryKey: {
                pk: { field: "pk", composite: ["n"] },
                sk: { field: "sk", composite: ["id"] },
              },
            }) as any
            const G = Entity.make({
              model: Schema.Struct({ id: Schema.String, code: Schema.String }),
              entityType: "Guarded",
              primaryKey: {
                pk: { field: "pk", composite: ["id"] },
                sk: { field: "sk", composite: [] },
              },
              ...(guard === "a retain put"
                ? { versioned: { retain: true } }
                : { unique: { code: ["code"] } }),
            } as never) as any
            const Main = Table.make({ schema, entities: { E, G } } as never) as any
            const Log = EventStore.makeStream({
              table: Main,
              streamName: "Log",
              events: [Schema.TaggedStruct("Logged", { note: Schema.String })],
              streamId: { composite: ["id"] },
            } as never) as any
            const table = makeRecordingTable()
            return Effect.gen(function* () {
              const db = yield* DynamoClient.make({
                entities: { E, G },
                tables: { Main },
              } as never) as Effect.Effect<any, never, any>
              const e = db.entities.E
              const g = db.entities.G
              yield* g.put({ id: "guarded", code: "before" }).asEffect()
              table.take()
              const stored = structuredClone([...table.items])
              const good =
                guard === "a unique update"
                  ? g.update({ id: "guarded" }).set({ code: "after" })
                  : g.put({ id: "guarded", code: "after" })
              const key = { id: "bad", n: 9007199254740993n }
              const refused =
                bad === "delete"
                  ? e.delete(key)
                  : bad === "check"
                    ? Transaction.check(e.get(key), Expression.condition({ attributeExists: "id" }))
                    : e.put(key)
              const ops = first ? [refused, good] : [good, refused]
              const exit = yield* Effect.exit(
                path === "Transaction.transactWrite"
                  ? Transaction.transactWrite(ops)
                  : Log.append({ id: "log" }, [{ _tag: "Logged", note: "event" }], 0, {
                      additionalItems: ops,
                    }),
              )
              expect(Exit.isFailure(exit)).toBe(true)
              if (Exit.isFailure(exit)) {
                expect(exit.cause.reasons[0]!._tag).toBe("Fail")
                const error = Cause.squash(exit.cause) as any
                expect(error._tag).toBe("ValidationError")
                expect(String(error.cause?.message ?? error.cause)).toContain(
                  bad === "put" ? "Expected number" : "EDD-9050",
                )
              }
              expect(table.requests).toEqual([])
              expect([...table.items]).toEqual(stored)
            }).pipe(
              Effect.provide(Main.layer({ name: "t" })),
              Effect.provide(table.layer),
            ) as Effect.Effect<void, unknown>
          })
        }
      }
    }
  }
})

describe("a transaction refuses an update's payload, or a nested append, before any op reads", () => {
  // What an update decides from its own payload, and a nested append's build, read nothing: they
  // run with every other op's checks, before a planned update or a guarded put reads. A payload
  // value that reads back otherwise (`EDD-9128`), one its schema refuses, an append op with no
  // events and an event its schema refuses used to be refused only after those reads.
  const payloads = [
    { name: "a value that reads back otherwise", Kind: Schema.Unknown, n: 5n, says: "EDD-9128" },
    { name: "a value its schema refuses", Kind: Schema.Number, n: "no", says: "Expected number" },
  ] as const
  const appends = [
    { name: "no events", events: [], says: "needs at least one event" },
    {
      name: "an event its schema refuses",
      events: [{ _tag: "Logged", note: 42 }],
      says: "Expected string",
    },
  ] as const
  const run = (
    Kind: Schema.Top,
    ops: (e: any, g: any, Inner: any) => { readonly bad: unknown; readonly good: unknown },
    send: (ops: ReadonlyArray<unknown>, Outer: any) => Effect.Effect<unknown, unknown, any>,
    first: boolean,
    says: string,
  ) => {
    const schema = DynamoSchema.make({ name: "inexactp", version: 1 })
    const E = Entity.make({
      model: Schema.Struct({ id: Schema.String, n: Kind }),
      entityType: "E",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      indexes: {
        byN: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["n"] },
          sk: { field: "gsi1sk", composite: [] },
        },
      },
    } as never) as any
    const G = Entity.make({
      model: Schema.Struct({ id: Schema.String, code: Schema.String }),
      entityType: "Guarded",
      primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
      unique: { code: ["code"] },
    } as never) as any
    const Main = Table.make({ schema, entities: { E, G } } as never) as any
    const stream = (streamName: string) =>
      EventStore.makeStream({
        table: Main,
        streamName,
        events: [Schema.TaggedStruct("Logged", { note: Schema.String })],
        streamId: { composite: ["id"] },
      } as never) as any
    const Outer = stream("Outer")
    const Inner = stream("Inner")
    const table = makeRecordingTable({ indexes: { gsi1: { pk: "gsi1pk", sk: "gsi1sk" } } })
    return Effect.gen(function* () {
      const db = yield* DynamoClient.make({
        entities: { E, G },
        tables: { Main },
      } as never) as Effect.Effect<any, never, any>
      yield* db.entities.E.put({ id: "bad", n: 1 }).asEffect()
      yield* db.entities.G.put({ id: "good", code: "before" }).asEffect()
      table.take()
      const stored = structuredClone([...table.items])
      const { bad, good } = ops(db.entities.E, db.entities.G, Inner)
      const exit = yield* Effect.exit(send(first ? [bad, good] : [good, bad], Outer))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons[0]!._tag).toBe("Fail")
        const error = Cause.squash(exit.cause) as any
        expect(error._tag).toBe("ValidationError")
        expect(String(error.cause?.message ?? error.cause)).toContain(says)
      }
      expect(table.requests).toEqual([])
      expect([...table.items]).toEqual(stored)
    }).pipe(
      Effect.provide(Main.layer({ name: "t" })),
      Effect.provide(table.layer),
    ) as Effect.Effect<void, unknown>
  }
  for (const first of [false, true]) {
    const order = first ? "before" : "after"
    for (const { name, Kind, n, says } of payloads) {
      for (const kind of ["update", "patch"] as const) {
        it.effect(`Transaction.transactWrite: ${kind} to ${name}, ${order} a unique update`, () =>
          run(
            Kind,
            (e, g) => ({
              bad: e[kind]({ id: "bad" }).set({ n }),
              good: g.update({ id: "good" }).set({ code: "after" }),
            }),
            (ops) => Transaction.transactWrite(ops as never),
            first,
            says,
          ),
        )
      }
    }
    for (const { name, events, says } of appends) {
      it.effect(`EventStore.append: an append op with ${name}, ${order} a unique put`, () =>
        run(
          Schema.Number,
          (_e, g, Inner) => ({
            bad: Inner.appendOp({ id: "inner" }, events, 0),
            good: g.put({ id: "good", code: "after" }),
          }),
          (ops, Outer) =>
            Outer.append({ id: "outer" }, [{ _tag: "Logged", note: "ok" }], 0, {
              additionalItems: ops,
            }),
          first,
          says,
        ),
      )
    }
  }
})
