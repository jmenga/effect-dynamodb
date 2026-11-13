/**
 * `DynamoModel.storedAs`'s signature takes every call 1.40.0 took (#236). Its type parameter is
 * the domain type, as it was: `storedAs<DateTime.Utc>(DateEpochSeconds)` compiles, and so does a
 * storage schema typed `Schema.Schema<A>`; both return the field schema's own type. Inferred from
 * the storage schema, the schema returned also carries {@link DynamoModel.StoredAs} (the storage
 * schema's encoded type, which the entity types read: `StoredAsTimestamps.types.test.ts`); the
 * property is optional, so that type and the field schema's are each assignable to the other.
 *
 * A storage schema of another domain type is still a compile error, and rightly: forced through
 * a cast, no `DateTime.Zoned` is stored as an epoch (the last cases).
 */
import { it } from "@effect/vitest"
import { Cause, DateTime, Effect, Exit, Schema } from "effect"
import { describe, expect, expectTypeOf } from "vitest"
import { DynamoClient, DynamoModel, DynamoSchema, Entity, Table } from "../src/index.js"
import { makeRecordingTable } from "./helpers/RecordingTable.js"

/** The type checker reads the body. Nothing runs it. */
const compiles = (_body: () => unknown) => undefined

describe("storedAs takes the calls 1.40.0 took", () => {
  it("with the domain type given", () => {
    compiles(() => {
      const utc = DynamoModel.storedAs<DateTime.Utc>(DynamoModel.DateEpochSeconds)(
        DynamoModel.DateString,
      )
      expectTypeOf(utc).toEqualTypeOf<typeof DynamoModel.DateString>()
      const date = DynamoModel.storedAs<Date>(DynamoModel.UnsafeDateEpochSeconds)(
        DynamoModel.UnsafeDateString,
      )
      expectTypeOf(date).toEqualTypeOf<typeof DynamoModel.UnsafeDateString>()
      const piped = DynamoModel.DateEpochMs.pipe(
        DynamoModel.storedAs<DateTime.Utc>(DynamoModel.DateString),
      )
      expectTypeOf(piped).toEqualTypeOf<typeof DynamoModel.DateEpochMs>()
    })
    expect(true).toBe(true)
  })

  it("with a storage schema typed Schema.Schema<A>", () => {
    compiles(() => {
      const storage: Schema.Schema<DateTime.Utc> = DynamoModel.DateEpochSeconds
      const field = DynamoModel.DateString.pipe(DynamoModel.storedAs(storage))
      expectTypeOf(field).toEqualTypeOf<typeof DynamoModel.DateString>()
    })
    expect(true).toBe(true)
  })

  it("inferred, carrying the storage schema's encoded type", () => {
    compiles(() => {
      let field = DynamoModel.DateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochSeconds))
      expectTypeOf(field).toEqualTypeOf<
        typeof DynamoModel.DateString & DynamoModel.StoredAs<number>
      >()
      expectTypeOf(field.Type).toEqualTypeOf<DateTime.Utc>()
      expectTypeOf(field.Encoded).toEqualTypeOf<string>()
      // Each is assignable to the other's type.
      const plain: typeof DynamoModel.DateString = field
      field = DynamoModel.DateString
      return [plain, field]
    })
    expect(true).toBe(true)
  })

  it("as a function of 1.40.0's type, and in a generic helper", () => {
    compiles(() => {
      const toSeconds: <S extends Schema.Schema<DateTime.Utc>>(fieldSchema: S) => S =
        DynamoModel.storedAs(DynamoModel.DateEpochSeconds)
      const helper = <S extends Schema.Schema<DateTime.Utc>>(fieldSchema: S): S =>
        DynamoModel.storedAs(DynamoModel.DateEpochSeconds)(fieldSchema)
      const model = Schema.Struct({
        at: Schema.optional(helper(DynamoModel.DateString)),
        seconds: toSeconds(DynamoModel.DateEpochMs),
      })
      expectTypeOf<(typeof model.Type)["at"]>().toEqualTypeOf<DateTime.Utc | undefined>()
      expectTypeOf<(typeof model.Type)["seconds"]>().toEqualTypeOf<DateTime.Utc>()
    })
    expect(true).toBe(true)
  })

  it("refuses a storage schema of another domain type", () => {
    compiles(() => {
      // @ts-expect-error DateTime.Zoned isn't DateTime.Utc
      DynamoModel.DateTimeZoned.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs))
      // @ts-expect-error DateTime.Zoned isn't DateTime.Utc
      DynamoModel.DateTimeZoned.pipe(DynamoModel.storedAs<DateTime.Utc>(DynamoModel.DateEpochMs))
      // @ts-expect-error Date isn't DateTime.Utc
      DynamoModel.UnsafeDateString.pipe(DynamoModel.storedAs(DynamoModel.DateEpochMs))
    })
    expect(true).toBe(true)
  })
})

describe("a DateTime.Zoned with an epoch storedAs, forced through a cast: never stored as one", () => {
  const forced = (field: Schema.Top) =>
    (DynamoModel.storedAs as (s: unknown) => (f: unknown) => Schema.Top)(DynamoModel.DateEpochMs)(
      field,
    )
  const primaryKey = { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } }
  const tokyo = DateTime.makeZonedUnsafe(1700000000000, { timeZone: "Asia/Tokyo" })

  /** Puts `tokyo` as `at` and reads it back, giving the stored attribute and the read. */
  const roundTrip = (at: Schema.Top) => {
    const Zoned = Entity.make({
      model: Schema.Struct({ id: Schema.String, at }),
      entityType: "Zoned",
      primaryKey,
    } as never) as any
    const Main = Table.make({
      schema: DynamoSchema.make({ name: "zonedepoch", version: 1 }),
      entities: { Zoned },
    } as never) as any
    const table = makeRecordingTable()
    return Effect.gen(function* () {
      const db: any = yield* DynamoClient.make({ entities: { Zoned }, tables: { Main } } as never)
      const put = yield* Effect.exit(db.entities.Zoned.put({ id: "1", at: tokyo }).asEffect())
      const row = [...table.items.values()][0] as Record<string, unknown> | undefined
      return { put, stored: row?.at }
    }).pipe(
      Effect.provide(Main.layer({ name: "t" })),
      Effect.provide(table.layer),
    ) as Effect.Effect<{
      put: Exit.Exit<unknown, any>
      stored: unknown
    }>
  }

  it("Entity.make refuses DynamoModel.DateTimeZoned so annotated: a transform owns its form", () => {
    expect(() =>
      Entity.make({
        model: Schema.Struct({ id: Schema.String, at: forced(DynamoModel.DateTimeZoned) }),
        entityType: "Zoned",
        primaryKey,
      } as never),
    ).toThrow(/cannot apply DynamoEncoding storage override to a transform schema/)
  })

  it.effect("under Schema.optional, it keeps its ISO form and its zone", () =>
    Effect.gen(function* () {
      const got = yield* roundTrip(Schema.optional(forced(DynamoModel.DateTimeZoned)) as never)
      expect(Exit.isSuccess(got.put)).toBe(true)
      expect(got.stored).toEqual({ S: "2023-11-15T07:13:20.000+09:00[Asia/Tokyo]" })
    }),
  )

  it.effect("a Schema.DateTimeZoned field so annotated refuses a zoned value at the write", () =>
    Effect.gen(function* () {
      const got = yield* roundTrip(forced(Schema.DateTimeZoned))
      expect(Exit.isFailure(got.put)).toBe(true)
      if (Exit.isFailure(got.put)) {
        expect((Cause.squash(got.put.cause) as any)._tag).toBe("ValidationError")
      }
      expect(got.stored).toBeUndefined()
    }),
  )
})
