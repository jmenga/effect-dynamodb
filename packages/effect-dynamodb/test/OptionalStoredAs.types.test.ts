/**
 * An optional date whose storage `DynamoModel.configure` sets (`storedAs`) stays optional at the
 * type level, in `Entity.Input`, `Entity.Record` and `Entity.Update`, as declared: the storage
 * changes what's stored, never the type. The run-time behaviour is pinned in
 * `helpers/OptionalStoredAs.ts`.
 */
import { DateTime, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { DynamoModel, Entity } from "../src/index.js"

class Booking extends Schema.Class<Booking>("OptionalStoredAsTypesBooking")({
  id: Schema.String,
  confirmed: Schema.optionalKey(Schema.DateTimeUtc),
  cancelled: Schema.optional(Schema.DateTimeUtc),
}) {}
const Bookings = Entity.make({
  model: DynamoModel.configure(Booking, {
    id: { identifier: true },
    confirmed: { storedAs: DynamoModel.DateEpochSeconds },
    cancelled: { storedAs: DynamoModel.DateEpochSeconds },
  }),
  entityType: "Booking",
  primaryKey: { pk: { field: "pk", composite: ["id"] }, sk: { field: "sk", composite: [] } },
})

describe("an optional date stored as configure says", () => {
  it("is optional in Entity.Input, Entity.Record and Entity.Update", () => {
    type Input = Entity.Input<typeof Bookings>
    expectTypeOf<Required<Input>["confirmed"]>().toEqualTypeOf<DateTime.Utc>()
    expectTypeOf<Required<Input>["cancelled"]>().toEqualTypeOf<DateTime.Utc | undefined>()
    const leftOut: Input = { id: "a" }
    // @ts-expect-error a `Schema.optionalKey` date takes no `undefined`
    const undefinedKey: Input = { id: "a", confirmed: undefined }
    // @ts-expect-error the stored form isn't the type
    const storedForm: Input = { id: "a", confirmed: 981173106 }

    type Record = Entity.Record<typeof Bookings>
    const read = (record: Record) => {
      // @ts-expect-error it may be absent
      const required: DateTime.Utc = record.confirmed
      const optional: DateTime.Utc | undefined = record.cancelled
      return [required, optional]
    }

    type Update = Entity.Update<typeof Bookings>
    const nothing: Update = {}
    const both: Update = { confirmed: DateTime.makeUnsafe(0), cancelled: undefined }
    expect([leftOut, undefinedKey, storedForm, read, nothing, both]).toHaveLength(6)
  })
})
