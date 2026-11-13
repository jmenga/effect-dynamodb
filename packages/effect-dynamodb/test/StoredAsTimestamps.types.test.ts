/**
 * A `Schema.optional` date over a transform whose `DynamoModel.storedAs` names the other wire kind
 * (`DateString.pipe(storedAs(DateEpochSeconds))`) is the caller's field under `timestamps: true`:
 * nothing stamps it, and an update sets or clears it, storing what it's given (1.40.0, #232). The
 * update types couldn't see `storedAs`, so they took it for a stamp: `.set({ createdAt })` and
 * `.remove(["createdAt"])` were compile errors, though both run (also on 1.39.0). `storedAs` now
 * carries the storage schema's encoded type in the type it returns, and the update types leave such
 * a field the caller's (#236). A date whose `storedAs` names the same wire kind, or one with no
 * transform, is still the library's. Nothing here runs but the last case.
 */
import { it } from "@effect/vitest"
import { DateTime, Effect, Schema } from "effect"
import { describe, expect } from "vitest"
import { DynamoClient, DynamoModel, DynamoSchema, Entity, Table } from "../src/index.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

const AppSchema = DynamoSchema.make({ name: "storedastypes", version: 1 })

const primaryKey = {
  pk: { field: "pk", composite: ["id"] },
  sk: { field: "sk", composite: [] },
} as const

/** Both timestamps are dates stored as the other wire kind than their transform's: the caller's. */
class Caller extends Schema.Class<Caller>("StoredAsCaller")({
  id: Schema.String,
  note: Schema.optional(Schema.String),
  createdAt: Schema.optional(
    DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
  ),
  updatedAt: Schema.optional(
    DynamoModel.DateEpochMs.pipe(DynamoModel.storedAs(DynamoModel.DateString)),
  ),
}) {}

const Callers = Entity.make({
  model: Caller,
  entityType: "Caller",
  primaryKey,
  timestamps: true,
})

/** The same kind, and a date with no transform: the library stamps both. */
class Stamped extends Schema.Class<Stamped>("StoredAsStamped")({
  id: Schema.String,
  note: Schema.optional(Schema.String),
  createdAt: Schema.optional(
    DynamoModel.DateEpochMs.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
  ),
  updatedAt: Schema.optional(
    Schema.DateTimeUtc.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds)),
  ),
}) {}

const Stampeds = Entity.make({
  model: Stamped,
  entityType: "Stamped",
  primaryKey,
  timestamps: true,
})

const MainTable = Table.make({ schema: AppSchema, entities: { Callers, Stampeds } })

const key = { id: "1" }
const at = DateTime.makeUnsafe(1700000000000)

/** The type checker reads the body. Nothing runs it. */
const compiles = (_body: () => unknown) => undefined

const db = () =>
  Effect.gen(function* () {
    const client = yield* DynamoClient.make({
      entities: { Callers, Stampeds },
      tables: { MainTable },
    })
    return client.entities
  })
type Db = Effect.Success<ReturnType<typeof db>>
const bound = undefined as unknown as Db

describe("a date stored as the other wire kind is the caller's to update", () => {
  it("BoundUpdate sets and clears it", () => {
    compiles(() => {
      bound.Callers.update(key).set({ createdAt: at })
      bound.Callers.update(key).set({ updatedAt: at })
      bound.Callers.update(key).set({ createdAt: undefined })
      bound.Callers.update(key).remove(["createdAt"])
      bound.Callers.update(key).remove(["updatedAt"])
      bound.Callers.update(key).remove(["createdAt", "updatedAt", "note"])
      bound.Callers.put({ id: "1" })
      bound.Callers.put({ id: "1", createdAt: at, updatedAt: at })
    })
    expect(true).toBe(true)
  })

  it("the unbound update sets and clears it", () => {
    compiles(() => {
      Entity.set(Callers.update(key), { createdAt: at })
      Entity.remove(Callers.update(key), ["createdAt", "updatedAt"])
      Callers.update(key).pipe(Entity.remove(["createdAt", "updatedAt"]))
    })
    expect(true).toBe(true)
  })

  it("a date the library stamps is still refused", () => {
    compiles(() => {
      bound.Stampeds.update(key).set({ note: "n" })
      // `updatedAt` is optional on every update, stamped or not.
      bound.Stampeds.update(key).set({ updatedAt: at })
      // @ts-expect-error the library stamps it: the same wire kind
      bound.Stampeds.update(key).set({ createdAt: at })
      // @ts-expect-error the library stamps it: the same wire kind
      bound.Stampeds.update(key).remove(["createdAt"])
      // @ts-expect-error the library stamps it: no transform
      bound.Stampeds.update(key).remove(["updatedAt"])
      // @ts-expect-error the library stamps it
      Entity.set(Stampeds.update(key), { createdAt: at })
      // @ts-expect-error the library stamps it
      Stampeds.update(key).pipe(Entity.remove(["createdAt"]))
    })
    expect(true).toBe(true)
  })

  it("storedAs still refuses a storage schema of another domain type", () => {
    compiles(() => {
      // @ts-expect-error DateTime.Zoned isn't DateTime.Utc
      DynamoModel.DateTimeZoned.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs))
    })
    expect(true).toBe(true)
  })
})

describe("as the run time has it", () => {
  it.effect("the update sets and clears the caller's date, in its transform's form", () => {
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      const client = yield* DynamoClient.make({
        entities: { Callers, Stampeds },
        tables: { MainTable },
      })
      yield* client.entities.Callers.put({ id: "1" })
      const row = () => [...table.items.values()][0] as Record<string, unknown>
      // Nothing stamps either field.
      expect(row().createdAt).toBeUndefined()
      expect(row().updatedAt).toBeUndefined()
      yield* client.entities.Callers.update(key).set({ createdAt: at, updatedAt: at })
      expect(row().createdAt).toEqual({ S: "2023-11-14T22:13:20.000Z" })
      expect(row().updatedAt).toEqual({ N: "1700000000000" })
      expect((yield* client.entities.Callers.get(key)).createdAt).toEqual(at)
      yield* client.entities.Callers.update(key).remove(["createdAt", "updatedAt"])
      expect(row().createdAt).toBeUndefined()
      expect(row().updatedAt).toBeUndefined()
    }).pipe(Effect.provide(MainTable.layer({ name: "t" })), Effect.provide(table.layer))
  })
})
