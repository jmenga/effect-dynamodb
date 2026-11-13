/**
 * What `insert` refuses at compile time (#189): a PartiQL `INSERT` has no
 * condition, and the multi-item paths would send a `PutItem` a role limited to
 * `PartiQLInsert` can't run.
 *
 * Compile-time only; checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type {
  ConditionalCheckFailed,
  ItemAlreadyExists,
  UniqueConstraintViolation,
} from "@effect-dynamodb/schema/Errors.js"
import { Effect, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Batch from "../src/Batch.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

const AppSchema = DynamoSchema.make({ name: "app", version: 1 })

class Note extends Schema.Class<Note>("Note")({
  noteId: Schema.String,
  body: Schema.String,
}) {}

const Notes = Entity.make({
  model: Note,
  entityType: "Note",
  primaryKey: {
    pk: { field: "pk", composite: ["noteId"] },
    sk: { field: "sk", composite: [] },
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Notes } })

const input = { noteId: "n", body: "b" }

describe("Entity.insert types", () => {
  it("refuses a condition", () => {
    const check = () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Notes }, tables: { MainTable } })
        // @ts-expect-error a PartiQL INSERT has no condition
        db.entities.Notes.insert(input).condition({ body: "b" })
        // @ts-expect-error a PartiQL INSERT has no condition
        Notes.condition({ body: "b" })(Notes.insert(input))
        // @ts-expect-error a PartiQL INSERT has no condition
        Notes.insert(input).pipe(Notes.condition({ body: "b" }))
      })
    expect(check).toBeTypeOf("function")
  })

  it("refuses the multi-item paths", () => {
    const check = () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Notes }, tables: { MainTable } })
        // @ts-expect-error insert cannot join a transaction
        yield* Transaction.transactWrite([Notes.insert(input)])
        // @ts-expect-error insert cannot join a transaction
        yield* Transaction.transactWrite([db.entities.Notes.insert(input)])
        // @ts-expect-error insert cannot join a batch
        yield* Batch.write([Notes.insert(input)])
        // @ts-expect-error insert cannot join a batch
        yield* Batch.write([db.entities.Notes.insert(input)])
      })
    expect(check).toBeTypeOf("function")
  })

  it("fails with ItemAlreadyExists, never ConditionalCheckFailed", () => {
    const check = () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({ entities: { Notes }, tables: { MainTable } })
        const insert = db.entities.Notes.insert(input).asEffect()
        type Failure = Effect.Error<typeof insert>
        expectTypeOf<ItemAlreadyExists>().toExtend<Failure>()
        expectTypeOf<UniqueConstraintViolation>().toExtend<Failure>()
        expectTypeOf<ConditionalCheckFailed>().not.toExtend<Failure>()
        expectTypeOf<Effect.Success<typeof insert>>().toEqualTypeOf<Note>()
        expectTypeOf<Effect.Services<typeof insert>>().toEqualTypeOf<never>()
        yield* insert
      })
    expect(check).toBeTypeOf("function")
  })
})
