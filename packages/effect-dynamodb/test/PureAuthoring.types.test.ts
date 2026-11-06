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

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import * as PureEntity from "@effect-dynamodb/schema/Entity.js"
import { type Effect, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
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

// Pure entity WITH a ref — the bound client must forward ref-derived `${field}Id`
// composites (not drop refs to `undefined`), which requires the shared AnyRefValue.
class Project extends Schema.Class<Project>("Project")({
  projectId: Schema.String.pipe(Schema.brand("ProjectId")),
  projectName: Schema.String,
}) {}
class Task extends Schema.Class<Task>("Task")({
  taskId: Schema.String,
  title: Schema.String,
  project: DynamoModel.ref(Project),
}) {}
const PureProjects = PureEntity.make({
  model: DynamoModel.configure(Project, { projectId: { identifier: true } }),
  entityType: "Project",
  primaryKey: { pk: { field: "pk", composite: ["projectId"] }, sk: { field: "sk", composite: [] } },
})
const PureTasks = PureEntity.make({
  model: Task,
  entityType: "Task",
  primaryKey: { pk: { field: "pk", composite: ["taskId"] }, sk: { field: "sk", composite: [] } },
  refs: { project: { entity: PureProjects } },
})
const PureRefsTable = Table.make({ schema: AppSchema, entities: { PureProjects, PureTasks } })
type RefsDb = Success<ReturnType<typeof makeRefsDb>>
const makeRefsDb = () =>
  DynamoClient.make({ entities: { PureProjects, PureTasks }, tables: { PureRefsTable } })
type TaskPutInput = Parameters<RefsDb["entities"]["PureTasks"]["put"]>[0]

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

  it("pure entity with refs forwards the ref-derived id (projectId) into the put input", () => {
    // The ref-derived id is present...
    expectTypeOf<TaskPutInput>().toHaveProperty("projectId")
    // ...and the raw ref field is replaced (not present). Before the fix the pure
    // branch dropped refs to `undefined`, leaving `project` here instead.
    expectTypeOf<TaskPutInput>().not.toHaveProperty("project")
  })
})

// A Z-order index (#171) authored with the PURE builder: the bound accessor
// takes the partition key composites only and offers no `.where()`, as with
// the runtime builder; `zorder` / `prefix` stay sort-key-only declarations.
class Listing extends Schema.Class<Listing>("Listing")({
  listingId: Schema.String,
  region: Schema.String,
  agencyId: Schema.String,
  price: Schema.Number,
}) {}
const listingFacets = [{ field: "price", min: 0, max: 5_000_000, step: 1_000 }] as const
const PureListings = PureEntity.make({
  model: Listing,
  entityType: "Listing",
  primaryKey: { pk: { field: "pk", composite: ["listingId"] }, sk: { field: "sk", composite: [] } },
  indexes: {
    byAgency: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["region"] },
      sk: { field: "gsi1sk", prefix: ["agencyId"], zorder: listingFacets },
    },
  },
})
const PureListingsTable = Table.make({ schema: AppSchema, entities: { PureListings } })
type ListingsDb = Success<ReturnType<typeof makeListingsDb>>
const makeListingsDb = () =>
  DynamoClient.make({ entities: { PureListings }, tables: { PureListingsTable } })
type ByAgency = ReturnType<ListingsDb["entities"]["PureListings"]["byAgency"]>

describe("#171 — pure-authored Z-order index (type level)", () => {
  it("derives the half's composite from prefix and dimensions", () => {
    type Composite = typeof PureListings.indexes.byAgency.sk.composite
    expectTypeOf<[Composite[0], Composite[1]]>().toEqualTypeOf<["agencyId", "price"]>()
  })

  it("binds an accessor over the partition key composites, without .where()", () => {
    type Input = Parameters<ListingsDb["entities"]["PureListings"]["byAgency"]>[0]
    expectTypeOf<keyof Input>().toEqualTypeOf<"region">()
    expectTypeOf<"where" extends keyof ByAgency ? true : false>().toEqualTypeOf<false>()
  })

  it("bounds the prefix composite and dimension, and tunes the plan with .zorder()", () => {
    type Bounds = Parameters<ByAgency["within"]>[0]
    expectTypeOf<keyof Bounds>().toEqualTypeOf<"agencyId" | "price">()
    expectTypeOf<NonNullable<Bounds["agencyId"]>>().toEqualTypeOf<string>()
    type Within = ReturnType<ByAgency["within"]>
    expectTypeOf<"zorder" extends keyof Within ? true : false>().toEqualTypeOf<true>()
    expectTypeOf<"within" extends keyof Within ? true : false>().toEqualTypeOf<false>()
  })

  it("refuses zorder / prefix outside a GSI sort key", () => {
    expect(() =>
      PureEntity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: {
          pk: { field: "pk", composite: ["listingId"] },
          // @ts-expect-error the primary key is string-composed
          sk: { field: "sk", composite: [], zorder: listingFacets },
        },
      }),
    ).toThrow(/\[EDD-9086\]/)
    expect(() =>
      PureEntity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: {
          pk: { field: "pk", composite: ["listingId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byAgency: {
            name: "gsi1",
            // @ts-expect-error a partition key is never a Z-order address
            pk: { field: "gsi1pk", composite: ["region"], zorder: listingFacets },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
      }),
    ).toThrow(/\[EDD-9086\]/)
  })
})
