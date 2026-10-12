/**
 * Error channels are unchanged by packed storage (#147).
 *
 * Packed storage is opt-in, so a consumer that never packs must see exactly
 * the error types it saw in 1.25.0 — an annotated error union or an exhaustive
 * `catchTags` handler written against 1.25.0 must keep compiling. A missing
 * compressor is surfaced at run time as a `ValidationError` whose `cause` is a
 * `CompressorNotRegistered`, never as a new member of an error union.
 *
 * Every assertion pins the exact 1.25.0 error type, for an entity with no
 * packed field and for one with packed (and compressed) fields alike: the
 * error types never depend on the storage config.
 *
 * Compile-time only; checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type {
  AdditionalItemConditionFailed,
  AggregateAssemblyError,
  AggregateDecompositionError,
  AggregateTransactionOverflow,
  AppendTooLarge,
  ConcurrentModification,
  ConditionalCheckFailed,
  DeleteAppliedButUnreadable,
  DuplicateCommand,
  ItemNotFound,
  OptimisticLockError,
  RefNotFound,
  TransactionCancelled,
  TransactionOverflow,
  UniqueConstraintViolation,
  UpdateAppliedButUnreadable,
  ValidationError,
  VersionConflict,
} from "@effect-dynamodb/schema/Errors.js"
import { type Effect, Schema, type Stream } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as Aggregate from "../src/Aggregate.js"
import * as Batch from "../src/Batch.js"
import type { DynamoClientError } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type * as EventStore from "../src/EventStore.js"
import type { AggregateCreateError, AggregateWriteError } from "../src/index.js"
import type * as Query from "../src/Query.js"
import type * as StorageEncoding from "../src/StorageEncoding.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

class Order extends Schema.Class<Order>("Order")({
  orderId: Schema.String,
  lines: Schema.Array(Schema.Struct({ sku: Schema.String })),
}) {}

const primaryKey = {
  pk: { field: "pk", composite: ["orderId"] },
  sk: { field: "sk", composite: [] },
} as const

const Plain = Entity.make({ model: Order, entityType: "PlainOrder", primaryKey })

const Packed = Entity.make({
  model: DynamoModel.configure(Order, {
    lines: {
      storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }),
    },
  }),
  entityType: "PackedOrder",
  primaryKey,
})

Table.make({
  schema: DynamoSchema.make({ name: "errors", version: 1 }),
  entities: { Plain, Packed },
})

/** Any `CompressorNotRegistered` left in an error union. */
type Leaked<E> = Extract<E, { readonly _tag: "CompressorNotRegistered" }>

type ErrorOf<T> = T extends { readonly asEffect: () => Effect.Effect<any, infer E, any> }
  ? E
  : T extends Effect.Effect<any, infer E, any>
    ? E
    : never

const key = { orderId: "o-1" }

// The functions below are type-checked, never executed.
const typeOnly = (_: () => void) => undefined

describe("error channels match 1.25.0 whether or not a field is packed (#147)", () => {
  it("unbound entity CRUD", () => {
    typeOnly(() => {
      for (const E of [Plain, Packed] as const) {
        expectTypeOf<ErrorOf<ReturnType<typeof E.get>>>().toEqualTypeOf<
          ItemNotFound | DynamoClientError | ValidationError
        >()
        expectTypeOf<ErrorOf<ReturnType<typeof E.put>>>().toEqualTypeOf<
          | DynamoClientError
          | TransactionOverflow
          | ValidationError
          | UniqueConstraintViolation
          | OptimisticLockError
          | ConcurrentModification
        >()
        expectTypeOf<ErrorOf<ReturnType<typeof E.update>>>().toEqualTypeOf<
          | DynamoClientError
          | TransactionOverflow
          | ItemNotFound
          | OptimisticLockError
          | ConcurrentModification
          | UpdateAppliedButUnreadable
          | UniqueConstraintViolation
          | ValidationError
        >()
        expectTypeOf<ErrorOf<ReturnType<typeof E.delete>>>().toEqualTypeOf<
          | DynamoClientError
          | TransactionOverflow
          | ItemNotFound
          | OptimisticLockError
          | ConcurrentModification
          | ValidationError
          | DeleteAppliedButUnreadable
        >()
        expectTypeOf<ErrorOf<ReturnType<typeof E.purge>>>().toEqualTypeOf<
          DynamoClientError | ValidationError
        >()
      }
    })
    expect(true).toBe(true)
  })

  it("Query terminals", () => {
    expectTypeOf<Effect.Error<ReturnType<typeof Query.collect<Order>>>>().toEqualTypeOf<
      DynamoClientError | ValidationError
    >()
    expectTypeOf<Effect.Error<ReturnType<typeof Query.execute<Order>>>>().toEqualTypeOf<
      DynamoClientError | ValidationError
    >()
    expectTypeOf<
      Stream.Error<Effect.Success<ReturnType<typeof Query.paginate<Order>>>>
    >().toEqualTypeOf<DynamoClientError | ValidationError>()
    expectTypeOf<Effect.Error<ReturnType<typeof Query.count<Order>>>>().toEqualTypeOf<
      DynamoClientError | ValidationError
    >()
  })

  it("Batch and Transaction", () => {
    typeOnly(() => {
      const got = Batch.get([Packed.get(key), Plain.get(key)])
      expectTypeOf<Effect.Error<typeof got>>().toEqualTypeOf<DynamoClientError | ValidationError>()
      const wrote = Batch.write([Packed.put({ orderId: "o", lines: [] })])
      expectTypeOf<Effect.Error<typeof wrote>>().toEqualTypeOf<
        DynamoClientError | ValidationError
      >()
      const tg = Transaction.transactGet([Packed.get(key)])
      expectTypeOf<Effect.Error<typeof tg>>().toEqualTypeOf<
        DynamoClientError | ValidationError | TransactionCancelled
      >()
      const tw = Transaction.transactWrite([Packed.put({ orderId: "o", lines: [] })])
      expectTypeOf<Leaked<Effect.Error<typeof tw>>>().toBeNever()
      expectTypeOf<Effect.Error<typeof tw>>().toEqualTypeOf<
        | DynamoClientError
        | ValidationError
        | TransactionCancelled
        | UniqueConstraintViolation
        | OptimisticLockError
        | ConcurrentModification
      >()
    })
    expect(true).toBe(true)
  })

  it("Aggregate", () => {
    expectTypeOf<Leaked<AggregateWriteError>>().toBeNever()
    expectTypeOf<Leaked<AggregateCreateError>>().toBeNever()
    expectTypeOf<AggregateWriteError>().toEqualTypeOf<
      | AggregateAssemblyError
      | AggregateDecompositionError
      | AggregateTransactionOverflow
      | DynamoClientError
      | ValidationError
      | RefNotFound
      | ItemNotFound
      | TransactionCancelled
    >()
    expectTypeOf<AggregateCreateError>().toEqualTypeOf<
      AggregateWriteError | ConditionalCheckFailed
    >()
    type Get = ReturnType<Aggregate.Aggregate<any, any>["get"]>
    expectTypeOf<Effect.Error<Get>>().toEqualTypeOf<
      AggregateAssemblyError | DynamoClientError | ValidationError
    >()
  })

  it("EventStore", () => {
    expectTypeOf<Leaked<EventStore.AppendError>>().toBeNever()
    expectTypeOf<EventStore.AppendError>().toEqualTypeOf<
      | VersionConflict
      | DuplicateCommand
      | AdditionalItemConditionFailed
      | AppendTooLarge
      | DynamoClientError
      | ValidationError
      | TransactionCancelled
      | UniqueConstraintViolation
      | OptimisticLockError
      | ConcurrentModification
    >()
  })

  it("StorageEncoding helpers fail with ValidationError only", () => {
    expectTypeOf<
      Effect.Error<ReturnType<typeof StorageEncoding.decode>>
    >().toEqualTypeOf<ValidationError>()
    expectTypeOf<
      Effect.Error<ReturnType<typeof StorageEncoding.decodeUnmarshalled>>
    >().toEqualTypeOf<ValidationError>()
    expectTypeOf<
      Effect.Error<ReturnType<typeof StorageEncoding.encode>>
    >().toEqualTypeOf<ValidationError>()
  })
})
