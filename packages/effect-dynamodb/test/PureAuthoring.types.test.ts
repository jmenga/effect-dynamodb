/**
 * Type-level regression for #69 — a pure `@effect-dynamodb/schema`
 * EntityDefinition bound via `DynamoClient.make` must produce a usable
 * `db.entities.X` (CRUD + index accessors + scan), NOT `never`.
 *
 * Before the fix, `TypedClient`'s entity mapping keyed off the runtime `Entity`
 * type, so a pure definition fell through to `never` and every `.get/.put/...`
 * typed as `never` — silently swallowing calls. These assertions fail to compile
 * if that regresses.
 */

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import { type Effect, Schema } from "effect"
import { describe, expectTypeOf, it } from "vitest"
import { DynamoClient } from "../src/DynamoClient.js"
import * as RuntimeEntity from "../src/Entity.js"
import * as Table from "../src/Table.js"

const AppSchema = DynamoSchema.make({ name: "pure-authoring-types", version: 1 })

class User extends Schema.Class<User>("User")({
  orgId: Schema.String,
  userId: Schema.String,
  email: Schema.String,
  name: Schema.String,
}) {}

// Authored with the PURE @effect-dynamodb/schema builder (no AWS dependency).
const PureUsers = PureEntity.make({
  model: User,
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["orgId"] },
    sk: { field: "sk", composite: ["userId"] },
  },
  indexes: {
    usersByOrg: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["orgId"] },
      sk: { field: "gsi1sk", composite: ["userId"] },
    },
  },
})

// Authored with the RUNTIME builder — must keep mapping correctly (no regression).
const RuntimeUsers = RuntimeEntity.make({
  model: User,
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["orgId"] },
    sk: { field: "sk", composite: ["userId"] },
  },
  indexes: {
    usersByOrg: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["orgId"] },
      sk: { field: "gsi1sk", composite: ["userId"] },
    },
  },
})

const PureTable = Table.make({ schema: AppSchema, entities: { Users: PureUsers } })
const RuntimeTable = Table.make({ schema: AppSchema, entities: { Users: RuntimeUsers } })

type Success<T> = T extends Effect.Effect<infer A, any, any> ? A : never

type PureDb = Success<ReturnType<typeof makePureDb>>
const makePureDb = () =>
  DynamoClient.make({ entities: { Users: PureUsers }, tables: { PureTable } })

type RuntimeDb = Success<ReturnType<typeof makeRuntimeDb>>
const makeRuntimeDb = () =>
  DynamoClient.make({ entities: { Users: RuntimeUsers }, tables: { RuntimeTable } })

describe("#69 — pure EntityDefinition binds to a usable client (type level)", () => {
  it("pure-authored entity does not resolve to never", () => {
    expectTypeOf<PureDb["entities"]["Users"]>().not.toBeNever()
  })

  it("pure-authored entity exposes CRUD methods", () => {
    expectTypeOf<PureDb["entities"]["Users"]["get"]>().toBeFunction()
    expectTypeOf<PureDb["entities"]["Users"]["put"]>().toBeFunction()
    expectTypeOf<PureDb["entities"]["Users"]["create"]>().toBeFunction()
    expectTypeOf<PureDb["entities"]["Users"]["update"]>().toBeFunction()
    expectTypeOf<PureDb["entities"]["Users"]["delete"]>().toBeFunction()
  })

  it("pure-authored entity exposes the index query accessor + scan", () => {
    expectTypeOf<PureDb["entities"]["Users"]["usersByOrg"]>().toBeFunction()
    expectTypeOf<PureDb["entities"]["Users"]["scan"]>().toBeFunction()
  })

  it("runtime-authored entity still maps correctly (no regression)", () => {
    expectTypeOf<RuntimeDb["entities"]["Users"]>().not.toBeNever()
    expectTypeOf<RuntimeDb["entities"]["Users"]["get"]>().toBeFunction()
    expectTypeOf<RuntimeDb["entities"]["Users"]["usersByOrg"]>().toBeFunction()
  })
})
