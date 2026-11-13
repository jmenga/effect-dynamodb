/**
 * The `key` on a write's error holds the primary key composites, not the input.
 *
 * Inputs reach these errors encoded, so a whole input would carry a
 * `Schema.RedactedFromValue` field in plaintext, and an error's fields end up
 * in logs. These tests hold every write path that used to pass one to that:
 * `.key` is exactly the composites, and the secret appears nowhere on the error.
 */

import { inspect } from "node:util"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import { beforeEach } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { toAttributeMap } from "../src/Marshaller.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"
import { hooks, InMemoryClient, resetStore, store } from "./helpers/InMemoryTables.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

const AppSchema = DynamoSchema.make({ name: "errkey", version: 1 })
const SECRET = "hunter2"

class Credential extends Schema.Class<Credential>("Credential")({
  id: Schema.String,
  scope: Schema.String,
  email: Schema.String,
  secret: Schema.RedactedFromValue(Schema.String),
  note: Schema.String,
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: ["scope"] },
} as const

const Plain = Entity.make({ model: Credential, entityType: "Plain", primaryKey })
const Versioned = Entity.make({
  model: Credential,
  entityType: "Versioned",
  primaryKey,
  versioned: true,
})
const Unique = Entity.make({
  model: Credential,
  entityType: "Unique",
  primaryKey,
  unique: { email: ["email"] },
})
const Renamed = Entity.make({
  model: DynamoModel.configure(Credential, {
    id: { field: "ID" },
    scope: { field: "SCOPE" },
  }),
  entityType: "Renamed",
  primaryKey,
  unique: { email: ["email"] },
})

const SecretUnique = Entity.make({
  model: Credential,
  entityType: "SecretUnique",
  primaryKey,
  unique: { secret: ["secret"] },
})

const reading = <S extends Schema.Top>(seq: S, entityType: string) => {
  const Reading = Schema.Struct({
    id: Schema.String,
    scope: Schema.String,
    seq,
    secret: Schema.RedactedFromValue(Schema.String),
    note: Schema.String,
  })
  return Entity.make({
    model: Reading,
    entityType,
    primaryKey,
    timeSeries: { orderBy: "seq", appendInput: Reading },
  })
}
const Readings = reading(Schema.Number, "Readings")
const TextReadings = reading(Schema.NumberFromString, "TextReadings")

const entities = { Plain, Versioned, Unique, Renamed, SecretUnique, Readings, TextReadings }
const MainTable = Table.make({ schema: AppSchema, entities })
const tableLayer = MainTable.layer({ name: "errkey" })
const layer = Layer.mergeAll(InMemoryClient, tableLayer)
const database = DynamoClient.make({ entities, tables: { MainTable } })

const input = {
  id: "c-1",
  scope: "admin",
  email: "a@example.com",
  secret: Redacted.make(SECRET),
  note: "n",
}
const key = { id: "c-1", scope: "admin" }
const readingInput = { id: "c-1", scope: "admin", seq: 5, secret: Redacted.make(SECRET), note: "n" }

/** The error names the key alone, whatever is printed or serialized from it. */
const expectOnlyKey = (error: unknown, tag: string) => {
  const failure = error as { readonly _tag: string; readonly key: unknown }
  expect(failure._tag).toBe(tag)
  expect(failure.key).toEqual(key)
  expect(JSON.stringify(error)).not.toContain(SECRET)
  expect(String(error)).not.toContain(SECRET)
}

beforeEach(() => {
  resetStore()
  hooks.afterGet = []
})

describe("an error's key on the write paths", () => {
  it.effect("create of a plain entity", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Plain.create(input).asEffect()
      const error = yield* db.entities.Plain.create(input).asEffect().pipe(Effect.flip)
      expectOnlyKey(error, "ConditionalCheckFailed")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("is the record get names for the same item, primary key fields included", () =>
    Effect.gen(function* () {
      const db = yield* database
      const missing = yield* db.entities.Plain.get(key).pipe(Effect.flip)
      expectOnlyKey(missing, "ItemNotFound")
      yield* db.entities.Plain.create(input).asEffect()
      const taken = yield* db.entities.Plain.create(input).asEffect().pipe(Effect.flip)
      expect((taken as { readonly key: unknown }).key).toEqual(
        (missing as { readonly key: unknown }).key,
      )
    }).pipe(Effect.provide(layer)),
  )

  it.effect("put with a condition", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Plain.put(input).asEffect()
      const error = yield* db.entities.Plain.put(input)
        .condition({ note: "other" })
        .asEffect()
        .pipe(Effect.flip)
      expectOnlyKey(error, "ConditionalCheckFailed")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("create of a guarded entity", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Versioned.create(input).asEffect()
      const error = yield* db.entities.Versioned.create(input).asEffect().pipe(Effect.flip)
      expectOnlyKey(error, "ConditionalCheckFailed")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a versioned put that keeps losing the race", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Versioned.put(input).asEffect()
      const bump = () => {
        for (const [at, row] of store) {
          store.set(at, { ...row, version: { N: String(Number(row.version?.N ?? 0) + 1) } })
        }
        hooks.afterGet.push(bump)
      }
      hooks.afterGet.push(bump)
      const error = yield* db.entities.Versioned.put(input).asEffect().pipe(Effect.flip)
      expectOnlyKey(error, "OptimisticLockError")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("an unversioned guarded put that keeps losing the race", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Unique.put(input).asEffect()
      // The guard watches the constrained attribute, so that's what moves.
      const touch = () => {
        for (const [at, row] of store) {
          if (row.email !== undefined) {
            store.set(at, { ...row, email: { S: `x${row.email.S}` } })
          }
        }
        hooks.afterGet.push(touch)
      }
      hooks.afterGet.push(touch)
      const error = yield* db.entities.Unique.put(input).asEffect().pipe(Effect.flip)
      expectOnlyKey(error, "ConcurrentModification")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("upsert with a condition", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Plain.put(input).asEffect()
      const error = yield* db.entities.Plain.upsert(input)
        .condition({ note: "other" })
        .asEffect()
        .pipe(Effect.flip)
      expectOnlyKey(error, "ConditionalCheckFailed")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("upsert answered with no attributes", () =>
    Effect.gen(function* () {
      const db = yield* database
      const error = yield* db.entities.Plain.upsert(input).asEffect().pipe(Effect.flip)
      expectOnlyKey(error, "ItemNotFound")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          mockDynamoClientLayer({ updateItem: () => Effect.succeed({ $metadata: {} }) }),
          tableLayer,
        ),
      ),
    ),
  )

  it.effect("insert of an existing item", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Plain.insert(input).asEffect()
      const error = yield* db.entities.Plain.insert(input).asEffect().pipe(Effect.flip)
      expectOnlyKey(error, "ItemAlreadyExists")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("append whose condition rejects creating the item", () =>
    Effect.gen(function* () {
      const db = yield* database
      const error = yield* db.entities.Readings.append(readingInput)
        .condition({ note: "other" })
        .asEffect()
        .pipe(Effect.flip)
      expectOnlyKey(error, "ConditionalCheckFailed")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("append whose condition rejects a newer value", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Readings.append(readingInput).asEffect()
      const error = yield* db.entities.Readings.append({ ...readingInput, seq: 6 })
        .condition({ note: "other" })
        .asEffect()
        .pipe(Effect.flip)
      expectOnlyKey(error, "ConditionalCheckFailed")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("append on a string-encoded orderBy whose condition rejects", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.TextReadings.append(readingInput).asEffect()
      const error = yield* db.entities.TextReadings.append({ ...readingInput, seq: 6 })
        .condition({ note: "other" })
        .asEffect()
        .pipe(Effect.flip)
      expectOnlyKey(error, "ConditionalCheckFailed")
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a renamed composite is named by its domain field, on every path", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Renamed.create(input).asEffect()
      expectOnlyKey(
        yield* db.entities.Renamed.create(input).asEffect().pipe(Effect.flip),
        "ConditionalCheckFailed",
      )
      expectOnlyKey(
        yield* db.entities.Renamed.insert(input).asEffect().pipe(Effect.flip),
        "ItemAlreadyExists",
      )
    }).pipe(Effect.provide(layer)),
  )

  it.effect("a transaction's put of a guarded entity", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Versioned.put(input).asEffect()
      const bump = () => {
        for (const [at, row] of store) {
          store.set(at, { ...row, version: { N: String(Number(row.version?.N ?? 0) + 1) } })
        }
        hooks.afterGet.push(bump)
      }
      hooks.afterGet.push(bump)
      const error = yield* Transaction.transactWrite([db.entities.Versioned.put(input)]).pipe(
        Effect.flip,
      )
      expectOnlyKey(error, "OptimisticLockError")
    }).pipe(Effect.provide(layer)),
  )
})

/** A field holding values is read by code and left out of everything that prints the error. */
const expectReadNotPrinted = (error: unknown, tag: string, field: string) => {
  const failure = error as Record<string, unknown>
  expect(failure._tag).toBe(tag)
  expect(failure[field]).toBeDefined()
  // Only printing leaves it out: a copy still holds it.
  expect({ ...failure }[field]).toBe(failure[field])
  for (const printed of [JSON.stringify(error), String(error), inspect(error, { depth: 10 })]) {
    expect(printed).not.toContain(SECRET)
    expect(printed).not.toMatch(new RegExp(`\\b${field}\\b`))
  }
}

describe("values on an error are read, never printed", () => {
  it.effect("UniqueConstraintViolation's fields, a redacted value among them", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.SecretUnique.put(input).asEffect()
      const error = yield* db.entities.SecretUnique.put({ ...input, id: "c-2" })
        .asEffect()
        .pipe(Effect.flip)
      expectReadNotPrinted(error, "UniqueConstraintViolation", "fields")
      expect((error as { readonly fields: unknown }).fields).toEqual({ secret: SECRET })
    }).pipe(Effect.provide(layer)),
  )

  it.effect("DeleteAppliedButUnreadable's item, the row as stored", () =>
    Effect.gen(function* () {
      const db = yield* database
      const error = yield* db.entities.Plain.delete(key)
        .returnValues("allOld")
        .asEffect()
        .pipe(Effect.flip)
      expectReadNotPrinted(error, "DeleteAppliedButUnreadable", "item")
      expect((error as { readonly item: Record<string, unknown> }).item.secret).toBe(SECRET)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          // The delete applies, and the row it removed is one the model can't read.
          mockDynamoClientLayer({
            deleteItem: () =>
              Effect.succeed({
                $metadata: {},
                Attributes: toAttributeMap({
                  __edd_e__: "Plain",
                  ...input,
                  secret: SECRET,
                  note: 5,
                }),
              }),
          }),
          tableLayer,
        ),
      ),
    ),
  )

  it.effect("StaleAppend's current, the row that won", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Readings.append({ ...readingInput, seq: 6 }).asEffect()
      const error = yield* db.entities.Readings.append(readingInput).asEffect().pipe(Effect.flip)
      expectReadNotPrinted(error, "StaleAppend", "current")
      expect(Option.isSome((error as { readonly current: Option.Option<unknown> }).current)).toBe(
        true,
      )
    }).pipe(Effect.provide(layer)),
  )

  it.effect("ConditionalCheckFailed's current, the row an append's condition was judged on", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Readings.append(readingInput).asEffect()
      const error = yield* db.entities.Readings.append({ ...readingInput, seq: 6 })
        .condition({ note: "other" })
        .asEffect()
        .pipe(Effect.flip)
      expectReadNotPrinted(error, "ConditionalCheckFailed", "current")
      expect(Option.isSome((error as { readonly current: Option.Option<unknown> }).current)).toBe(
        true,
      )
    }).pipe(Effect.provide(layer)),
  )

  it.effect("ConcurrentModification's current, the row as stored", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Unique.put(input).asEffect()
      const touch = () => {
        for (const [at, row] of store) {
          if (row.email !== undefined) store.set(at, { ...row, email: { S: `x${row.email.S}` } })
        }
        hooks.afterGet.push(touch)
      }
      hooks.afterGet.push(touch)
      const error = yield* db.entities.Unique.put(input).asEffect().pipe(Effect.flip)
      expectReadNotPrinted(error, "ConcurrentModification", "current")
    }).pipe(Effect.provide(layer)),
  )
})

describe("the fixture", () => {
  it.effect("stores the secret as text, so its absence from the errors above means something", () =>
    Effect.gen(function* () {
      const db = yield* database
      yield* db.entities.Plain.put(input).asEffect()
      const [row] = [...store.values()]
      expect(row?.secret).toEqual({ S: SECRET })
    }).pipe(Effect.provide(layer)),
  )
})
