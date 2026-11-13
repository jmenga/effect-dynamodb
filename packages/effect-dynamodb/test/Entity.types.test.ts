/**
 * Type-level tests for Entity type extractors.
 * Uses vitest's `expectTypeOf` to verify compile-time type relationships.
 */

import * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import type { ItemNotFound, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import type { IndexPkInput } from "@effect-dynamodb/schema/internal/EntityTypes.js"
import { type DateTime, Effect, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as Batch from "../src/Batch.js"
import { DynamoClient, type DynamoClientError } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Expression from "../src/Expression.js"
import type { DimensionBound, RangeBound, ZOrder } from "../src/index.js"
import type * as Query from "../src/Query.js"
import * as Table from "../src/Table.js"
import type { ConditionCheckOp } from "../src/Transaction.js"
import * as Transaction from "../src/Transaction.js"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const AppSchema = DynamoSchema.make({ name: "testapp", version: 1 })

class User extends Schema.Class<User>("User")({
  userId: Schema.String,
  email: Schema.String,
  displayName: Schema.NonEmptyString,
  role: Schema.Literals(["admin", "member"]),
}) {}

/** Simple entity — no timestamps, no versioning, no refs */
const UserEntity = Entity.make({
  model: User,
  entityType: "User",
  primaryKey: {
    pk: { field: "pk", composite: ["userId"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byRole: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["role"] },
      sk: { field: "gsi1sk", composite: ["userId"] },
    },
  },
})

/** Entity with timestamps + versioning */
const VersionedUserEntity = Entity.make({
  model: User,
  entityType: "VersionedUser",
  primaryKey: {
    pk: { field: "pk", composite: ["userId"] },
    sk: { field: "sk", composite: [] },
  },
  timestamps: true,
  versioned: true,
})

/** Entity with compound key (pk + sk composites) */
class Membership extends Schema.Class<Membership>("Membership")({
  orgId: Schema.String,
  userId: Schema.String,
  role: Schema.Literals(["owner", "admin", "member"]),
}) {}

const MembershipEntity = Entity.make({
  model: Membership,
  entityType: "Membership",
  primaryKey: {
    pk: { field: "pk", composite: ["orgId"] },
    sk: { field: "sk", composite: ["userId"] },
  },
})

/** Ref-aware entities */
class Team extends Schema.Class<Team>("Team")({
  teamId: Schema.String.pipe(DynamoModel.identifier),
  name: Schema.String,
  country: Schema.String,
}) {}

class Player extends Schema.Class<Player>("Player")({
  playerId: Schema.String.pipe(DynamoModel.identifier),
  displayName: Schema.String,
  position: Schema.String,
}) {}

class Selection extends Schema.Class<Selection>("Selection")({
  selectionId: Schema.String,
  team: Team.pipe(DynamoModel.ref),
  player: Player.pipe(DynamoModel.ref),
  role: Schema.String,
}) {}

const TeamEntity = Entity.make({
  model: Team,
  entityType: "Team",
  primaryKey: {
    pk: { field: "pk", composite: ["teamId"] },
    sk: { field: "sk", composite: [] },
  },
})

const PlayerEntity = Entity.make({
  model: Player,
  entityType: "Player",
  primaryKey: {
    pk: { field: "pk", composite: ["playerId"] },
    sk: { field: "sk", composite: [] },
  },
})

const SelectionEntity = Entity.make({
  model: Selection,
  entityType: "Selection",
  primaryKey: {
    pk: { field: "pk", composite: ["selectionId"] },
    sk: { field: "sk", composite: [] },
  },
  refs: {
    team: { entity: TeamEntity },
    player: { entity: PlayerEntity },
  },
})

/** Branded type entities — verify branded IDs flow through Entity.Input, Key, Update */
const BrandedTeamId = Schema.String.pipe(Schema.brand("BTeamId"))
type BrandedTeamId = typeof BrandedTeamId.Type

const BrandedPlayerId = Schema.String.pipe(Schema.brand("BPlayerId"))
type BrandedPlayerId = typeof BrandedPlayerId.Type

class BrandedTeam extends Schema.Class<BrandedTeam>("BrandedTeam")({
  id: BrandedTeamId,
  name: Schema.String,
}) {}

class BrandedPlayer extends Schema.Class<BrandedPlayer>("BrandedPlayer")({
  id: BrandedPlayerId,
  name: Schema.String,
}) {}

class BrandedSelection extends Schema.Class<BrandedSelection>("BrandedSelection")({
  id: Schema.String,
  team: BrandedTeam,
  player: BrandedPlayer,
  role: Schema.String,
}) {}

const BrandedTeamEntity = Entity.make({
  model: DynamoModel.configure(BrandedTeam, {
    id: { field: "teamId", identifier: true },
  }),
  entityType: "BrandedTeam",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})

const BrandedPlayerEntity = Entity.make({
  model: DynamoModel.configure(BrandedPlayer, {
    id: { field: "playerId", identifier: true },
  }),
  entityType: "BrandedPlayer",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
})

const BrandedSelectionEntity = Entity.make({
  model: DynamoModel.configure(BrandedSelection, {
    id: { field: "selectionId", identifier: true },
    team: { ref: true },
    player: { ref: true },
  }),
  entityType: "BrandedSelection",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
  refs: {
    team: { entity: BrandedTeamEntity },
    player: { entity: BrandedPlayerEntity },
  },
})

/**
 * Repro fixture for the bug where GSI pk/sk composites that reference a
 * ref's renamed db field name (e.g. `teamId` from a `team: Team.pipe(ref)`
 * field) used to silently collapse `IndexPkInput` to `Pick<Model, never>`.
 *
 * Mirrors the gamemanager tutorial's `SquadSelection` shape: identifier
 * field renamed via `DynamoModel.configure({ id: { field: "selectionId" } })`,
 * two ref fields (`team`, `player`), and GSIs whose pk composites use the
 * derived `${ref}Id` names.
 */
class BrandedRefSelection extends Schema.Class<BrandedRefSelection>("BrandedRefSelection")({
  id: Schema.String,
  team: BrandedTeam,
  player: BrandedPlayer,
  season: Schema.String,
  series: Schema.String,
  selectionNumber: Schema.Number,
  squadRole: Schema.Literals(["batter", "bowler", "allrounder", "wicketkeeper"]),
  isCaptain: Schema.Boolean,
  isViceCaptain: Schema.Boolean,
}) {}

const BrandedRefSelectionEntity = Entity.make({
  model: DynamoModel.configure(BrandedRefSelection, {
    id: { field: "selectionId", identifier: true },
    team: { ref: true },
    player: { ref: true },
  }),
  entityType: "BrandedRefSelection",
  primaryKey: {
    pk: { field: "pk", composite: ["id"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byTeamSeries: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["teamId", "season", "series"] },
      sk: { field: "gsi1sk", composite: ["selectionNumber"] },
    },
    byPlayer: {
      name: "gsi2",
      pk: { field: "gsi2pk", composite: ["playerId"] },
      sk: { field: "gsi2sk", composite: ["season", "series"] },
    },
  },
  refs: {
    team: { entity: BrandedTeamEntity },
    player: { entity: BrandedPlayerEntity },
  },
})

/** A ref's id as a primary key composite: a key names it, an update can't change it. */
class BrandedRoster extends Schema.Class<BrandedRoster>("BrandedRoster")({
  id: Schema.String,
  team: BrandedTeam,
  role: Schema.String,
}) {}

const BrandedRosterEntity = Entity.make({
  model: DynamoModel.configure(BrandedRoster, { team: { ref: true } }),
  entityType: "BrandedRoster",
  primaryKey: {
    pk: { field: "pk", composite: ["teamId"] },
    sk: { field: "sk", composite: ["id"] },
  },
  refs: { team: { entity: BrandedTeamEntity } },
})

const _MainTable = Table.make({
  schema: AppSchema,
  entities: {
    UserEntity,
    VersionedUserEntity,
    MembershipEntity,
    TeamEntity,
    PlayerEntity,
    SelectionEntity,
    BrandedTeamEntity,
    BrandedPlayerEntity,
    BrandedSelectionEntity,
    BrandedRefSelectionEntity,
    BrandedRosterEntity,
  },
})

// ---------------------------------------------------------------------------
// Type extractor tests
// ---------------------------------------------------------------------------

describe("Entity type extractors", () => {
  it("Entity.Model extracts pure model type", () => {
    type UserModel = Entity.Model<typeof UserEntity>

    // Should have all model fields with correct types
    expectTypeOf<UserModel>().toHaveProperty("userId")
    expectTypeOf<UserModel>().toHaveProperty("email")
    expectTypeOf<UserModel>().toHaveProperty("displayName")
    expectTypeOf<UserModel>().toHaveProperty("role")

    expectTypeOf<UserModel["userId"]>().toEqualTypeOf<string>()
    expectTypeOf<UserModel["email"]>().toEqualTypeOf<string>()
    expectTypeOf<UserModel["displayName"]>().toEqualTypeOf<string>()
    expectTypeOf<UserModel["role"]>().toEqualTypeOf<"admin" | "member">()

    // Should NOT have system fields
    expectTypeOf<UserModel>().not.toHaveProperty("createdAt")
    expectTypeOf<UserModel>().not.toHaveProperty("updatedAt")
    expectTypeOf<UserModel>().not.toHaveProperty("version")
  })

  it("Entity.Record includes system fields when timestamps and versioned are configured", () => {
    type VersionedRecord = Entity.Record<typeof VersionedUserEntity>

    // Should have all model fields
    expectTypeOf<VersionedRecord>().toHaveProperty("userId")
    expectTypeOf<VersionedRecord>().toHaveProperty("email")
    expectTypeOf<VersionedRecord>().toHaveProperty("displayName")
    expectTypeOf<VersionedRecord>().toHaveProperty("role")

    // Should have timestamp system fields as DateTime.Utc
    expectTypeOf<VersionedRecord>().toHaveProperty("createdAt")
    expectTypeOf<VersionedRecord>().toHaveProperty("updatedAt")
    expectTypeOf<VersionedRecord["createdAt"]>().toEqualTypeOf<DateTime.Utc>()
    expectTypeOf<VersionedRecord["updatedAt"]>().toEqualTypeOf<DateTime.Utc>()

    // Should have version field
    expectTypeOf<VersionedRecord>().toHaveProperty("version")
    expectTypeOf<VersionedRecord["version"]>().toEqualTypeOf<number>()
  })

  it("Entity.Record omits system fields when timestamps/versioned not configured", () => {
    type PlainRecord = Entity.Record<typeof UserEntity>

    // Should have model fields
    expectTypeOf<PlainRecord>().toHaveProperty("userId")
    expectTypeOf<PlainRecord>().toHaveProperty("email")

    // Should NOT have system fields
    expectTypeOf<PlainRecord>().not.toHaveProperty("createdAt")
    expectTypeOf<PlainRecord>().not.toHaveProperty("updatedAt")
    expectTypeOf<PlainRecord>().not.toHaveProperty("version")
  })

  it("Entity.Input extracts input type for simple entities", () => {
    type UserInput = Entity.Input<typeof UserEntity>

    // Should have all model fields
    expectTypeOf<UserInput>().toHaveProperty("userId")
    expectTypeOf<UserInput>().toHaveProperty("email")
    expectTypeOf<UserInput>().toHaveProperty("displayName")
    expectTypeOf<UserInput>().toHaveProperty("role")

    expectTypeOf<UserInput["userId"]>().toEqualTypeOf<string>()

    // Should NOT have system fields
    expectTypeOf<UserInput>().not.toHaveProperty("createdAt")
    expectTypeOf<UserInput>().not.toHaveProperty("updatedAt")
    expectTypeOf<UserInput>().not.toHaveProperty("version")
  })

  it("Entity.Input replaces ref fields with Id fields for ref-aware entities", () => {
    type SelectionInput = Entity.Input<typeof SelectionEntity>

    // Non-ref fields remain
    expectTypeOf<SelectionInput>().toHaveProperty("selectionId")
    expectTypeOf<SelectionInput>().toHaveProperty("role")

    // Ref fields replaced with Id fields
    expectTypeOf<SelectionInput>().toHaveProperty("teamId")
    expectTypeOf<SelectionInput>().toHaveProperty("playerId")
    expectTypeOf<SelectionInput["teamId"]>().toEqualTypeOf<string>()
    expectTypeOf<SelectionInput["playerId"]>().toEqualTypeOf<string>()

    // Original ref fields should NOT be present
    expectTypeOf<SelectionInput>().not.toHaveProperty("team")
    expectTypeOf<SelectionInput>().not.toHaveProperty("player")
  })

  it("Entity.Update makes all fields optional and excludes primary key composites", () => {
    type UserUpdate = Entity.Update<typeof UserEntity>

    // Updatable fields should be optional
    expectTypeOf<UserUpdate>().toExtend<{
      email?: string
      displayName?: string
      role?: "admin" | "member"
    }>()

    // Primary key composites should be excluded
    expectTypeOf<UserUpdate>().not.toHaveProperty("userId")
  })

  it("Entity.Update excludes compound key composites", () => {
    type MemberUpdate = Entity.Update<typeof MembershipEntity>

    // Only non-key field is role
    expectTypeOf<MemberUpdate>().toExtend<{
      role?: "owner" | "admin" | "member"
    }>()

    // Both pk and sk composites should be excluded
    expectTypeOf<MemberUpdate>().not.toHaveProperty("orgId")
    expectTypeOf<MemberUpdate>().not.toHaveProperty("userId")
  })

  it("Entity.Update replaces ref fields with optional Id fields for ref-aware entities", () => {
    type SelectionUpdate = Entity.Update<typeof SelectionEntity>

    // Non-key, non-ref field is optional
    expectTypeOf<SelectionUpdate>().toExtend<{
      role?: string
    }>()

    // Ref fields replaced with optional Id fields
    expectTypeOf<SelectionUpdate>().toHaveProperty("teamId")
    expectTypeOf<SelectionUpdate>().toHaveProperty("playerId")

    // Original ref fields should NOT be present
    expectTypeOf<SelectionUpdate>().not.toHaveProperty("team")
    expectTypeOf<SelectionUpdate>().not.toHaveProperty("player")

    // Primary key should be excluded
    expectTypeOf<SelectionUpdate>().not.toHaveProperty("selectionId")
  })

  it("Entity.Key includes only primary key composite attributes", () => {
    // Single pk composite, empty sk composite
    type UserKey = Entity.Key<typeof UserEntity>

    expectTypeOf<UserKey>().toHaveProperty("userId")
    expectTypeOf<UserKey["userId"]>().toEqualTypeOf<string>()

    // Non-key fields should NOT be present
    expectTypeOf<UserKey>().not.toHaveProperty("email")
    expectTypeOf<UserKey>().not.toHaveProperty("displayName")
    expectTypeOf<UserKey>().not.toHaveProperty("role")
  })

  it("Entity.Key includes both pk and sk composites for compound keys", () => {
    type MemberKey = Entity.Key<typeof MembershipEntity>

    // pk composite
    expectTypeOf<MemberKey>().toHaveProperty("orgId")
    expectTypeOf<MemberKey["orgId"]>().toEqualTypeOf<string>()

    // sk composite
    expectTypeOf<MemberKey>().toHaveProperty("userId")
    expectTypeOf<MemberKey["userId"]>().toEqualTypeOf<string>()

    // Non-key field should NOT be present
    expectTypeOf<MemberKey>().not.toHaveProperty("role")
  })

  it("Entity.Key does NOT include GSI composite attributes", () => {
    type UserKey = Entity.Key<typeof UserEntity>

    // role is a GSI composite (byRole index), NOT a primary key composite
    expectTypeOf<UserKey>().not.toHaveProperty("role")
    expectTypeOf<UserKey>().not.toHaveProperty("email")
    expectTypeOf<UserKey>().not.toHaveProperty("displayName")

    // Only primary key composite
    expectTypeOf<UserKey>().toEqualTypeOf<{ readonly userId: string }>()
  })

  it("Entity.Item extends Record with key attributes and entity type discriminator", () => {
    type UserItem = Entity.Item<typeof UserEntity>

    // Should have model fields
    expectTypeOf<UserItem>().toHaveProperty("userId")
    expectTypeOf<UserItem>().toHaveProperty("email")

    // Should have DynamoDB key attributes
    expectTypeOf<UserItem>().toHaveProperty("pk")
    expectTypeOf<UserItem>().toHaveProperty("sk")

    // Should have entity type discriminator
    expectTypeOf<UserItem>().toHaveProperty("__edd_e__")
  })

  it("Entity.Marshalled returns AttributeValue record type", () => {
    type UserMarshalled = Entity.Marshalled<typeof UserEntity>

    // Should be a record with AttributeValue-like fields
    expectTypeOf<UserMarshalled>().toExtend<
      Record<
        string,
        {
          readonly S?: string
          readonly N?: string
          readonly BOOL?: boolean
          readonly NULL?: boolean
          readonly L?: ReadonlyArray<unknown>
          readonly M?: Record<string, unknown>
        }
      >
    >()
  })

  // -------------------------------------------------------------------------
  // Branded type tests
  // -------------------------------------------------------------------------

  it("Entity.Input preserves branded types for non-ref entities", () => {
    type BTeamInput = Entity.Input<typeof BrandedTeamEntity>

    expectTypeOf<BTeamInput["id"]>().toEqualTypeOf<BrandedTeamId>()
    expectTypeOf<BTeamInput["name"]>().toEqualTypeOf<string>()
  })

  it("Entity.Key preserves branded types", () => {
    type BTeamKey = Entity.Key<typeof BrandedTeamEntity>

    expectTypeOf<BTeamKey["id"]>().toEqualTypeOf<BrandedTeamId>()
  })

  it("Entity.Input preserves branded types for ref Id fields", () => {
    type BSelInput = Entity.Input<typeof BrandedSelectionEntity>

    // Ref fields should be replaced with branded Id fields
    expectTypeOf<BSelInput["teamId"]>().toEqualTypeOf<BrandedTeamId>()
    expectTypeOf<BSelInput["playerId"]>().toEqualTypeOf<BrandedPlayerId>()

    // Original ref fields should NOT be present
    expectTypeOf<BSelInput>().not.toHaveProperty("team")
    expectTypeOf<BSelInput>().not.toHaveProperty("player")
  })

  it("Entity.Update preserves branded types for ref Id fields", () => {
    type BSelUpdate = Entity.Update<typeof BrandedSelectionEntity>

    expectTypeOf<BSelUpdate>().toHaveProperty("teamId")
    expectTypeOf<BSelUpdate>().toHaveProperty("playerId")

    // Primary key should be excluded
    expectTypeOf<BSelUpdate>().not.toHaveProperty("id")
  })

  it("Entity.Key includes a ref's id that is a primary key composite; Entity.Update leaves it out", () => {
    type RosterKey = Entity.Key<typeof BrandedRosterEntity>
    expectTypeOf<RosterKey>().toEqualTypeOf<{
      readonly teamId: BrandedTeamId
      readonly id: string
    }>()
    const teamId = BrandedTeamId.make("t-1")
    const key: RosterKey = { teamId, id: "r-1" }
    // @ts-expect-error the ref's id is part of the key
    const withoutTeam: RosterKey = { id: "r-1" }

    type RosterUpdate = Entity.Update<typeof BrandedRosterEntity>
    expectTypeOf<RosterUpdate>().toHaveProperty("role")
    expectTypeOf<RosterUpdate>().not.toHaveProperty("teamId")
    // @ts-expect-error no update changes the key
    const repoint: RosterUpdate = { teamId }

    // The entity's own key-taking operations, and a bound client's, take it.
    const typed = () =>
      Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { BrandedTeamEntity, BrandedRosterEntity },
          tables: { _MainTable },
        })
        yield* db.entities.BrandedRosterEntity.get({ teamId, id: "r-1" })
        yield* db.entities.BrandedRosterEntity.update({ teamId, id: "r-1" }).set({ role: "c" })
        // @ts-expect-error no update changes the key
        yield* db.entities.BrandedRosterEntity.update(key).set({ teamId })
        return BrandedRosterEntity.delete(key)
      })
    expect([key, withoutTeam, repoint, typed]).toHaveLength(4)
  })

  // ---------------------------------------------------------------------------
  // A model field named like a timestamp: managed if it's a date, otherwise the caller's
  // ---------------------------------------------------------------------------

  it("put: a date `createdAt` is optional; a plain one stays as the model says", () => {
    const primaryKey = {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    } as const
    const Dated = Entity.make({
      model: Schema.Struct({
        id: Schema.String,
        createdAt: Schema.DateTimeUtc,
        updatedAt: Schema.optional(Schema.DateTimeUtc),
      }),
      entityType: "Dated",
      primaryKey,
      timestamps: true,
    })
    type DatedInput = Parameters<typeof Dated.put>[0]
    expectTypeOf<{ readonly id: string }>().toExtend<DatedInput>()
    expectTypeOf<NonNullable<DatedInput["createdAt"]>>().toEqualTypeOf<DateTime.Utc>()
    expectTypeOf<NonNullable<DatedInput["updatedAt"]>>().toEqualTypeOf<DateTime.Utc>()

    const Plain = Entity.make({
      model: Schema.Struct({
        id: Schema.String,
        createdAt: Schema.String,
        updatedAt: Schema.optional(Schema.String),
      }),
      entityType: "Plain",
      primaryKey,
      timestamps: true,
    })
    // At runtime the plain `createdAt` is required (`Missing key`) and stamped by nobody.
    type PlainInput = Parameters<typeof Plain.put>[0]
    expectTypeOf<{ readonly id: string }>().not.toExtend<PlainInput>()
    expectTypeOf<{ readonly id: string; readonly createdAt: string }>().toExtend<PlainInput>()
    expectTypeOf<PlainInput["createdAt"]>().toEqualTypeOf<string>()
    expectTypeOf<NonNullable<PlainInput["updatedAt"]>>().toEqualTypeOf<string>()
    // And an update may name it, since the writer owns it. A date `createdAt` it may not.
    void (() => Plain.update({ id: "a" }).pipe(Entity.set({ createdAt: "2026" })))
    void (() =>
      Dated.update({ id: "a" }).pipe(
        // @ts-expect-error the library keeps a date `createdAt`
        Entity.set({ createdAt: DateTime.makeUnsafe(0) }),
      ))
  })

  // -------------------------------------------------------------------------
  // Entity.Create type tests
  // -------------------------------------------------------------------------

  it("Entity.Create omits identifier field when configured via DynamoModel.configure", () => {
    type BTeamCreate = Entity.Create<typeof BrandedTeamEntity>

    // Should have non-identifier fields
    expectTypeOf<BTeamCreate>().toHaveProperty("name")
    expectTypeOf<BTeamCreate["name"]>().toEqualTypeOf<string>()

    // Identifier field should be excluded
    expectTypeOf<BTeamCreate>().not.toHaveProperty("id")
  })

  it("Entity.Create omits identifier for ref-aware entities", () => {
    type BSelCreate = Entity.Create<typeof BrandedSelectionEntity>

    // Ref fields replaced with Id fields
    expectTypeOf<BSelCreate>().toHaveProperty("teamId")
    expectTypeOf<BSelCreate>().toHaveProperty("playerId")
    expectTypeOf<BSelCreate["teamId"]>().toEqualTypeOf<BrandedTeamId>()
    expectTypeOf<BSelCreate["playerId"]>().toEqualTypeOf<BrandedPlayerId>()

    // Non-ref field present
    expectTypeOf<BSelCreate>().toHaveProperty("role")

    // Identifier field should be excluded
    expectTypeOf<BSelCreate>().not.toHaveProperty("id")
  })

  it("Entity.Create falls back to PK composites when no identifier configured", () => {
    type UserCreate = Entity.Create<typeof UserEntity>

    // Non-PK fields present
    expectTypeOf<UserCreate>().toHaveProperty("email")
    expectTypeOf<UserCreate>().toHaveProperty("displayName")
    expectTypeOf<UserCreate>().toHaveProperty("role")

    // No identifier configured → Create keeps the PK composite "userId": the
    // caller must supply it to create the item (matches this test's name and
    // the runtime create() input, exercised in the connected suite). createSchema
    // only drops a configured `identifier`/`generatedId`, not raw PK composites.
    expectTypeOf<UserCreate>().toHaveProperty("userId")
  })

  it("Entity.Create matches createSchema type", () => {
    type BTeamCreate = Entity.Create<typeof BrandedTeamEntity>
    type CreateSchemaType = Schema.Schema.Type<typeof BrandedTeamEntity.createSchema>

    expectTypeOf<BTeamCreate>().toEqualTypeOf<CreateSchemaType>()
  })

  // -------------------------------------------------------------------------
  // Schema accessor tests
  // -------------------------------------------------------------------------

  it("inputSchema type matches Entity.Input for simple entities", () => {
    type InputSchemaType = Schema.Schema.Type<typeof UserEntity.inputSchema>
    type InputType = Entity.Input<typeof UserEntity>

    expectTypeOf<InputSchemaType>().toEqualTypeOf<InputType>()
  })

  it("inputSchema type matches Entity.Input for ref-aware entities", () => {
    type InputSchemaType = Schema.Schema.Type<typeof SelectionEntity.inputSchema>
    type InputType = Entity.Input<typeof SelectionEntity>

    expectTypeOf<InputSchemaType>().toEqualTypeOf<InputType>()
  })

  it("inputSchema type preserves branded ref ID types", () => {
    type InputSchemaType = Schema.Schema.Type<typeof BrandedSelectionEntity.inputSchema>

    expectTypeOf<InputSchemaType>().toHaveProperty("teamId")
    expectTypeOf<InputSchemaType>().toHaveProperty("playerId")
    expectTypeOf<InputSchemaType["teamId"]>().toEqualTypeOf<BrandedTeamId>()
    expectTypeOf<InputSchemaType["playerId"]>().toEqualTypeOf<BrandedPlayerId>()
  })

  it("createSchema keeps PK composites when no identifier is configured", () => {
    type CreateSchemaType = Schema.Schema.Type<typeof UserEntity.createSchema>

    // Should have non-PK fields
    expectTypeOf<CreateSchemaType>().toHaveProperty("email")
    expectTypeOf<CreateSchemaType>().toHaveProperty("displayName")
    expectTypeOf<CreateSchemaType>().toHaveProperty("role")

    // No identifier configured → the PK composite "userId" stays required (the
    // caller supplies it to create the item). createSchema drops a configured
    // `identifier`/`generatedId`, not raw PK composites.
    expectTypeOf<CreateSchemaType>().toHaveProperty("userId")
  })

  it("createSchema type preserves branded ref ID types", () => {
    type CreateSchemaType = Schema.Schema.Type<typeof BrandedSelectionEntity.createSchema>

    expectTypeOf<CreateSchemaType>().toHaveProperty("teamId")
    expectTypeOf<CreateSchemaType>().toHaveProperty("playerId")
    expectTypeOf<CreateSchemaType["teamId"]>().toEqualTypeOf<BrandedTeamId>()
    expectTypeOf<CreateSchemaType["playerId"]>().toEqualTypeOf<BrandedPlayerId>()

    // Primary key should be excluded
    expectTypeOf<CreateSchemaType>().not.toHaveProperty("id")
  })

  it("updateSchema type matches Entity.Update", () => {
    type UpdateSchemaType = Schema.Schema.Type<typeof UserEntity.updateSchema>
    type UpdateType = Entity.Update<typeof UserEntity>

    expectTypeOf<UpdateSchemaType>().toEqualTypeOf<UpdateType>()
  })

  it("updateSchema type matches Entity.Update for ref-aware entities", () => {
    type UpdateSchemaType = Schema.Schema.Type<typeof SelectionEntity.updateSchema>
    type UpdateType = Entity.Update<typeof SelectionEntity>

    expectTypeOf<UpdateSchemaType>().toEqualTypeOf<UpdateType>()
  })

  it("rejects primary index with both pk and sk composites empty", () => {
    expect(() =>
      Entity.make({
        model: User,
        entityType: "User",
        // The type now also rejects an entirely-empty primary key at compile
        // time; cast so the RUNTIME guard is still exercised (defends untyped /
        // JS callers).
        primaryKey: {
          pk: { field: "pk", composite: [] as const },
          sk: { field: "sk", composite: [] as const },
        } as never,
      }),
    ).toThrow()
  })

  it("allows primary index with empty pk if sk has composites", () => {
    Entity.make({
      model: User,
      entityType: "User",
      primaryKey: {
        pk: { field: "pk", composite: [] },
        sk: { field: "sk", composite: ["userId"] },
      },
    })
  })

  it("allows primary index with empty sk if pk has composites", () => {
    Entity.make({
      model: User,
      entityType: "User",
      primaryKey: {
        pk: { field: "pk", composite: ["userId"] },
        sk: { field: "sk", composite: [] },
      },
    })
  })

  it("rejects composite attributes that are not model fields", () => {
    // A composite names a model field or a ref-derived `${field}Id` (#54):
    // anything else is a type error on the name, and make() throws for
    // untyped callers.
    expect(() =>
      Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          // @ts-expect-error not a model field
          pk: { field: "pk", composite: ["nonExistent"] },
          sk: { field: "sk", composite: [] },
        },
      }),
    ).toThrow()
  })

  it("rejects invalid GSI composite attributes", () => {
    expect(() =>
      Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byBogus: {
            name: "gsi1",
            // @ts-expect-error not a model field
            pk: { field: "gsi1pk", composite: ["bogus"] },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
      }),
    ).toThrow()
  })

  // -------------------------------------------------------------------------
  // IndexPkInput — query accessor input type tests
  // -------------------------------------------------------------------------

  it("IndexPkInput requires PK composites, SK composites optional", () => {
    type ByRoleInput = IndexPkInput<typeof User, typeof UserEntity.indexes, "byRole">

    // PK only
    const pkOnly: ByRoleInput = { role: "admin" }
    expect(pkOnly.role).toBe("admin")

    // PK + optional SK
    const pkAndSk: ByRoleInput = { role: "admin", userId: "u1" }
    expect(pkAndSk.role).toBe("admin")

    // Excess property rejected at compile time
    // @ts-expect-error — bogus is not a valid composite attribute
    const _excess: ByRoleInput = { role: "admin", bogus: "x" }
  })

  // -------------------------------------------------------------------------
  // IndexPkInput — ref-renamed composite attribute resolution
  // -------------------------------------------------------------------------
  //
  // Regression: an entity that uses `DynamoModel.ref` for a field (e.g.
  // `team: Team`) and references the ref's renamed db field (`teamId`) in a
  // GSI's pk composite previously collapsed `IndexPkInput` to
  // `Pick<Model, never>`, silently dropping the required composite. The fix
  // resolves ref-renamed composite names against the referenced entity's
  // identifier value type.
  //
  // The conditional must be applied INLINE at the call site (not via an
  // intermediate `type Refs = ...` alias) so that TypeScript preserves the
  // literal `TRefs` shape. This mirrors how `Entity.query.byPlayer` is typed
  // internally — `IndexPkInput<M, I, K, TRefs>` is computed inside the
  // `Entity.query` mapped type, not via post-hoc inference.
  it("IndexPkInput resolves ref-renamed composites for both pk and sk", () => {
    type ProbeIndex<E, K extends string> =
      E extends Entity.Entity<
        infer M extends Schema.Top,
        any,
        infer I,
        any,
        any,
        any,
        any,
        infer R,
        any
      >
        ? K extends keyof I
          ? IndexPkInput<M, I, K, R>
          : never
        : never

    type SquadByPlayer = ProbeIndex<typeof BrandedRefSelectionEntity, "byPlayer">
    type SquadByTeamSeries = ProbeIndex<typeof BrandedRefSelectionEntity, "byTeamSeries">

    // pk-only ref-renamed composite is required (not silently dropped).
    // Before the fix, `IndexPkInput` collapsed to just `{ season?, series? }`
    // because `playerId` did not exist on the raw model — only on the refs.
    expectTypeOf<SquadByPlayer>().toHaveProperty("playerId")
    expectTypeOf<SquadByPlayer>().toHaveProperty("season")
    expectTypeOf<SquadByPlayer>().toHaveProperty("series")

    // The branded `BrandedPlayerId` flows through (with the `IndexPkInput`
    // CaseInsensitive widening applying `| Lowercase<...>` for string types,
    // which is intentional and shared with all other index input types).
    type PlayerIdField = SquadByPlayer["playerId"]
    expectTypeOf<BrandedPlayerId>().toExtend<PlayerIdField>()

    // Mixed pk: ref-renamed composite + regular model fields all required.
    expectTypeOf<SquadByTeamSeries>().toHaveProperty("teamId")
    expectTypeOf<SquadByTeamSeries>().toHaveProperty("season")
    expectTypeOf<SquadByTeamSeries>().toHaveProperty("series")
    type TeamIdField = SquadByTeamSeries["teamId"]
    expectTypeOf<BrandedTeamId>().toExtend<TeamIdField>()

    // SK composite (`selectionNumber`) appears as an optional field.
    expectTypeOf<SquadByTeamSeries>().toHaveProperty("selectionNumber")
  })

  it("query accessors accept ref-renamed pk composites at compile time", () => {
    // Compile-time only — these expressions should typecheck without error.
    // Each call exercises a query accessor whose pk composite uses the
    // renamed `${ref}Id` form (e.g. `playerId` for a `player: Player.pipe(ref)` field).
    const _byPlayer = (): Query.Query<unknown> =>
      BrandedRefSelectionEntity.query.byPlayer({
        playerId: "p1" as BrandedPlayerId,
      })
    // `byTeamSeries` requires all pk composites: teamId (ref-renamed), season, series.
    const _byTeamSeries = (): Query.Query<unknown> =>
      BrandedRefSelectionEntity.query.byTeamSeries({
        teamId: "t1" as BrandedTeamId,
        season: "2026",
        series: "ipl",
      })
    // SK composites of the same index are optional — `selectionNumber` may be omitted.
    const _byTeamSeriesNoSk = (): Query.Query<unknown> =>
      BrandedRefSelectionEntity.query.byTeamSeries({
        teamId: "t1" as BrandedTeamId,
        season: "2026",
        series: "ipl",
      })
    expect(typeof _byPlayer).toBe("function")
    expect(typeof _byTeamSeries).toBe("function")
    expect(typeof _byTeamSeriesNoSk).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// Time-series (`timeSeries`) type-level tests
// ---------------------------------------------------------------------------

describe("Entity types — timeSeries", () => {
  class Telemetry extends Schema.Class<Telemetry>("Telemetry")({
    channel: Schema.String,
    deviceId: Schema.String,
    timestamp: Schema.DateTimeUtc,
    accountId: Schema.optional(Schema.String),
    location: Schema.optional(Schema.String),
  }) {}

  const TelemetryAppendInput = Schema.Struct({
    channel: Schema.String,
    deviceId: Schema.String,
    timestamp: Schema.DateTimeUtc,
    location: Schema.optional(Schema.String),
  })

  const TsEntity = Entity.make({
    model: Telemetry,
    entityType: "Telemetry",
    primaryKey: {
      pk: { field: "pk", composite: ["channel", "deviceId"] },
      sk: { field: "sk", composite: [] },
    },
    timeSeries: {
      orderBy: "timestamp",
      appendInput: TelemetryAppendInput,
    },
  })

  // Fabricate a BoundEntity type from the Entity — we don't need a runtime bind
  // for type-level tests.
  type TsBound = import("../src/Entity.js").BoundEntity<
    typeof Telemetry,
    typeof TsEntity.indexes,
    undefined,
    { readonly channel: string; readonly deviceId: string },
    typeof TsEntity.timeSeries
  >

  it("BoundEntity.append input narrows to appendInput schema fields", () => {
    // Type-level: append accepts appendInput shape.
    type AppendFn = TsBound["append"]
    type AppendArg = AppendFn extends (input: infer A, ...args: any[]) => any ? A : never
    type Expected = Schema.Schema.Type<typeof TelemetryAppendInput>

    expectTypeOf<AppendArg>().toEqualTypeOf<Expected>()
    // `accountId` (model-only field) must NOT be in the input.
    type HasAccountId = "accountId" extends keyof AppendArg ? true : false
    expectTypeOf<HasAccountId>().toEqualTypeOf<false>()
  })

  it("append default-path success type is { current: Model }", () => {
    type AppendFn = TsBound["append"]
    type Builder = AppendFn extends (...args: any[]) => infer R ? R : never
    // BoundAppend.asEffect() yields the success type.
    type AsEffectFn = Builder extends { readonly asEffect: () => infer E } ? E : never
    type Success = AsEffectFn extends import("effect").Effect.Effect<infer A, any, any> ? A : never

    type Expected = { readonly current: Telemetry }
    expectTypeOf<Success>().toEqualTypeOf<Expected>()
  })

  it("append .skipFollowUp() narrows success to void", () => {
    type AppendFn = TsBound["append"]
    type Builder = AppendFn extends (...args: any[]) => infer R ? R : never
    type Skipped = Builder extends { readonly skipFollowUp: () => infer S } ? S : never
    type AsEffectFn = Skipped extends { readonly asEffect: () => infer E } ? E : never
    type Success = AsEffectFn extends import("effect").Effect.Effect<infer A, any, any> ? A : never
    expectTypeOf<Success>().toEqualTypeOf<void>()
  })

  it("append errors include StaleAppend on default path", () => {
    type AppendFn = TsBound["append"]
    type Builder = AppendFn extends (...args: any[]) => infer R ? R : never
    type AsEffectFn = Builder extends { readonly asEffect: () => infer E } ? E : never
    type Errors = AsEffectFn extends import("effect").Effect.Effect<any, infer E, any> ? E : never
    // Project errors to their `_tag` discriminators and assert StaleAppend
    // is present.
    type ErrorTags = Errors extends { readonly _tag: infer T } ? T : never
    type HasStale = "StaleAppend" extends ErrorTags ? true : false
    expectTypeOf<HasStale>().toEqualTypeOf<true>()
  })

  it(".history() callback `t` has only orderBy keys", () => {
    type HistoryFn = TsBound["history"]
    // Call signature returns BoundQuery<Model, { timestamp: string }, Model>.
    type HistoryResult = HistoryFn extends (key: any) => infer R ? R : never
    type WhereFn = HistoryResult extends { readonly where: infer W } ? W : never
    // The callback's first arg is `SkRemaining` = { readonly timestamp: string }.
    type SkArg = WhereFn extends (fn: (t: infer T, ops: any) => any) => any ? T : never
    // Must include `timestamp`.
    type HasTimestamp = "timestamp" extends keyof SkArg ? true : false
    expectTypeOf<HasTimestamp>().toEqualTypeOf<true>()
    // Must NOT include other model fields.
    type HasChannel = "channel" extends keyof SkArg ? true : false
    expectTypeOf<HasChannel>().toEqualTypeOf<false>()
  })

  it("second .where() on history is a type error (SkRemaining exhausted)", () => {
    type HistoryFn = TsBound["history"]
    type HistoryResult = HistoryFn extends (key: any) => infer R ? R : never
    type WhereFn = HistoryResult extends { readonly where: infer W } ? W : never
    type AfterWhere = WhereFn extends (fn: any) => infer R ? R : never
    // After one .where(), SkRemaining = never and `where` no longer exists.
    type HasWhere = "where" extends keyof AfterWhere ? true : false
    expectTypeOf<HasWhere>().toEqualTypeOf<false>()
  })

  it("entity without timeSeries: .append is `never`", () => {
    const Plain = Entity.make({
      model: Telemetry,
      entityType: "Telemetry",
      primaryKey: {
        pk: { field: "pk", composite: ["channel", "deviceId"] },
        sk: { field: "sk", composite: [] },
      },
    })
    type PlainBound = import("../src/Entity.js").BoundEntity<
      typeof Telemetry,
      typeof Plain.indexes,
      undefined,
      { readonly channel: string; readonly deviceId: string },
      undefined
    >
    expectTypeOf<PlainBound["append"]>().toEqualTypeOf<never>()
    expectTypeOf<PlainBound["history"]>().toEqualTypeOf<never>()
  })
})

// ---------------------------------------------------------------------------
// `.condition()` widens the error channel with ConditionalCheckFailed (#102)
// ---------------------------------------------------------------------------

describe("Entity types — .condition() error channel", () => {
  type UserBound = import("../src/Entity.js").BoundEntity<
    typeof User,
    typeof UserEntity.indexes,
    undefined,
    { readonly userId: string }
  >

  /** Pull the error channel out of anything exposing `asEffect()`. */
  type ErrorOf<T> = T extends {
    readonly asEffect: () => import("effect").Effect.Effect<any, infer E, any>
  }
    ? E
    : never

  /** Distribute a union of tagged errors into its `_tag` literals. */
  type TagsOf<E> = E extends { readonly _tag: infer Tag } ? Tag : never

  type HasCcf<T> = "ConditionalCheckFailed" extends TagsOf<ErrorOf<T>> ? true : false

  type BoundPutOf<K extends "put" | "create" | "upsert"> = ReturnType<UserBound[K]>
  type BoundUpdateOf<K extends "update" | "patch"> = ReturnType<UserBound[K]>
  type BoundDeleteOf<K extends "delete" | "deleteIfExists"> = ReturnType<UserBound[K]>

  const input = {
    userId: "u-1",
    email: "u@example.com",
    displayName: "U",
    role: "admin",
  } as const

  it("put(): ConditionalCheckFailed absent before .condition(), present after", () => {
    expectTypeOf<HasCcf<BoundPutOf<"put">>>().toEqualTypeOf<false>()
    type Conditioned = ReturnType<BoundPutOf<"put">["condition"]>
    expectTypeOf<HasCcf<Conditioned>>().toEqualTypeOf<true>()
  })

  it("delete(): ConditionalCheckFailed absent before .condition(), present after", () => {
    expectTypeOf<HasCcf<BoundDeleteOf<"delete">>>().toEqualTypeOf<false>()
    type Conditioned = ReturnType<BoundDeleteOf<"delete">["condition"]>
    expectTypeOf<HasCcf<Conditioned>>().toEqualTypeOf<true>()
  })

  it("update(): ConditionalCheckFailed absent before .condition(), present after", () => {
    expectTypeOf<HasCcf<BoundUpdateOf<"update">>>().toEqualTypeOf<false>()
    type Conditioned = ReturnType<BoundUpdateOf<"update">["condition"]>
    expectTypeOf<HasCcf<Conditioned>>().toEqualTypeOf<true>()
  })

  it(".condition() widening survives further combinators", () => {
    type Conditioned = ReturnType<BoundUpdateOf<"update">["condition"]>
    type ThenSet = ReturnType<Conditioned["set"]>
    type ThenVersion = ReturnType<ThenSet["expectedVersion"]>
    expectTypeOf<HasCcf<ThenSet>>().toEqualTypeOf<true>()
    expectTypeOf<HasCcf<ThenVersion>>().toEqualTypeOf<true>()
  })

  it(".condition() on an update preserves the update payload type", () => {
    type Base = BoundUpdateOf<"update">
    type Conditioned = ReturnType<Base["condition"]>
    expectTypeOf<Parameters<Conditioned["set"]>>().toEqualTypeOf<Parameters<Base["set"]>>()
  })

  it("ops that already declare ConditionalCheckFailed are unchanged by .condition()", () => {
    expectTypeOf<HasCcf<BoundPutOf<"create">>>().toEqualTypeOf<true>()
    expectTypeOf<HasCcf<BoundPutOf<"upsert">>>().toEqualTypeOf<true>()
    expectTypeOf<HasCcf<BoundUpdateOf<"patch">>>().toEqualTypeOf<true>()
    expectTypeOf<HasCcf<BoundDeleteOf<"deleteIfExists">>>().toEqualTypeOf<true>()

    // The union collapses — the error channel is identical before and after.
    type CreateConditioned = ReturnType<BoundPutOf<"create">["condition"]>
    expectTypeOf<ErrorOf<CreateConditioned>>().toEqualTypeOf<ErrorOf<BoundPutOf<"create">>>()
  })

  it("OptimisticLockError is unconditional on update — .expectedVersion() does not widen", () => {
    // Unlike `.condition()`, `.expectedVersion()` adds no error: the base
    // channel already declares `OptimisticLockError` because a retain/unique
    // update CASes whether or not an expected version was supplied.
    type Base = BoundUpdateOf<"update">
    type WithVersion = ReturnType<Base["expectedVersion"]>
    type HasLock<T> = "OptimisticLockError" extends TagsOf<ErrorOf<T>> ? true : false
    expectTypeOf<HasLock<Base>>().toEqualTypeOf<true>()
    expectTypeOf<ErrorOf<WithVersion>>().toEqualTypeOf<ErrorOf<Base>>()
  })

  it("unbound Entity.condition() pipeable widens put/update/delete", () => {
    const put = UserEntity.put(input)
    const update = UserEntity.update({ userId: "u-1" })
    const del = UserEntity.delete({ userId: "u-1" })

    const conditionedPut = put.pipe(UserEntity.condition({ role: "admin" }))
    const conditionedUpdate = update.pipe(UserEntity.condition((t, { eq }) => eq(t.role, "admin")))
    const conditionedDelete = del.pipe(UserEntity.condition({ role: "admin" }))

    expectTypeOf<HasCcf<typeof put>>().toEqualTypeOf<false>()
    expectTypeOf<HasCcf<typeof update>>().toEqualTypeOf<false>()
    expectTypeOf<HasCcf<typeof del>>().toEqualTypeOf<false>()

    expectTypeOf<HasCcf<typeof conditionedPut>>().toEqualTypeOf<true>()
    expectTypeOf<HasCcf<typeof conditionedUpdate>>().toEqualTypeOf<true>()
    expectTypeOf<HasCcf<typeof conditionedDelete>>().toEqualTypeOf<true>()

    // An update piped through `condition` stays an EntityUpdate — the `U`
    // parameter must not be flattened away by the EntityPut-shaped overload.
    expect(Entity.EntityUpdateTypeId in conditionedUpdate).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// `get()` returns a BoundGet — an Effect that is ALSO a read descriptor (#108)
//
// The wrapper exists so `Batch.get` / `Transaction.transactGet` /
// `Transaction.check` can unwrap a descriptor out of the bound client. Every
// assertion below pins the surface `get` had BEFORE the wrapper existed: if one
// of them stops compiling, the wrapper became a breaking change.
// ---------------------------------------------------------------------------

describe("Entity types — bound get() is still an Effect", () => {
  type UserBound = import("../src/Entity.js").BoundEntity<
    typeof User,
    typeof UserEntity.indexes,
    undefined,
    { readonly userId: string }
  >
  type BoundGetOfUser = ReturnType<UserBound["get"]>
  type UnboundGetOfUser = ReturnType<typeof UserEntity.get>
  // Unchanged by packed storage (#147): a missing compressor is a
  // ValidationError whose cause is CompressorNotRegistered.
  type GetErrors = ItemNotFound | DynamoClientError | ValidationError

  // `users` is a type-level stand-in and the functions below are never called.
  // The COMPILE is the assertion: these are the exact call shapes callers
  // already write today.
  const users = null as unknown as UserBound

  const effectSurface = () =>
    Effect.gen(function* () {
      // 1. `yield*` gives the model, unchanged.
      const direct: User = yield* users.get({ userId: "u-1" })

      // 2. `.pipe(Effect.catchTag(...))` — the shape the issue names
      //    explicitly. Tag narrowing must still work, and the handled error
      //    must leave the channel.
      const orNull: User | null = yield* users
        .get({ userId: "u-1" })
        .pipe(Effect.catchTag("ItemNotFound", () => Effect.succeed(null)))

      // 3. Ordinary Effect combinators take it directly.
      const name: string = yield* users
        .get({ userId: "u-1" })
        .pipe(Effect.map((u) => u.displayName))

      // 4. It composes structurally with other Effects.
      const both: readonly [User, User] = yield* Effect.all([
        users.get({ userId: "u-1" }),
        users.get({ userId: "u-2" }),
      ])

      return { direct, orNull, name, both }
    })

  const descriptorSurface = (): readonly [ConditionCheckOp, ConditionCheckOp] => [
    Transaction.check(
      users.get({ userId: "u-1" }),
      Expression.condition({ attributeExists: "pk" }),
    ),
    users
      .get({ userId: "u-1" })
      .pipe(Transaction.check(Expression.condition({ attributeExists: "pk" }))),
  ]

  it("get() is assignable to the Effect it used to return", () => {
    expectTypeOf<BoundGetOfUser>().toExtend<Effect.Effect<User, GetErrors, never>>()
    // R is still `never` — the bound client resolved every service.
    expectTypeOf<Effect.Services<BoundGetOfUser>>().toEqualTypeOf<never>()
    expectTypeOf<Effect.Success<BoundGetOfUser>>().toEqualTypeOf<User>()
    expectTypeOf<Effect.Error<BoundGetOfUser>>().toEqualTypeOf<GetErrors>()
  })

  it("yield*, catchTag, Effect.map and Effect.all all still type-check", () => {
    expectTypeOf<ReturnType<typeof effectSurface>>().toExtend<
      Effect.Effect<
        {
          direct: User
          orNull: User | null
          name: string
          both: readonly [User, User]
        },
        GetErrors,
        never
      >
    >()
  })

  it("Batch.get infers per-position types, mixing bound and unbound gets", () => {
    type Result = ReturnType<
      typeof Batch.get<readonly [BoundGetOfUser, BoundGetOfUser, UnboundGetOfUser]>
    >
    expectTypeOf<Effect.Success<Result>>().toEqualTypeOf<
      [User | undefined, User | undefined, User | undefined]
    >()
  })

  it("Transaction.transactGet infers per-position types, mixing bound and unbound", () => {
    type Result = ReturnType<
      typeof Transaction.transactGet<readonly [BoundGetOfUser, UnboundGetOfUser]>
    >
    expectTypeOf<Effect.Success<Result>>().toEqualTypeOf<[User | undefined, User | undefined]>()
  })

  it("Transaction.check takes a bound get data-first and data-last", () => {
    expectTypeOf<ReturnType<typeof descriptorSurface>>().toEqualTypeOf<
      readonly [ConditionCheckOp, ConditionCheckOp]
    >()
  })
})

// ---------------------------------------------------------------------------
// `delete().returnValues("allOld")` types the deleted item (#133)
// ---------------------------------------------------------------------------

describe("Entity types — delete returnValues", () => {
  type UserBound = import("../src/Entity.js").BoundEntity<
    typeof User,
    typeof UserEntity.indexes,
    undefined,
    { readonly userId: string }
  >
  type Delete = ReturnType<UserBound["delete"]>
  type ValueOf<T> = T extends {
    readonly asEffect: () => import("effect").Effect.Effect<infer A, any, any>
  }
    ? A
    : never
  // Never executed — the descriptors only feed `typeof`.
  const del = null as unknown as Delete

  it('a delete returns nothing; "allOld" returns the model or undefined', () => {
    if (del === null) return
    expectTypeOf<ValueOf<Delete>>().toEqualTypeOf<void>()
    const allOld = del.returnValues("allOld")
    expectTypeOf<ValueOf<typeof allOld>>().toEqualTypeOf<User | undefined>()
    const conditioned = del.returnValues("allOld").condition({ role: "admin" })
    expectTypeOf<ValueOf<typeof conditioned>>().toEqualTypeOf<User | undefined>()
    expectTypeOf<ValueOf<ReturnType<typeof del.returnValues<"none">>>>().toEqualTypeOf<void>()
  })

  it("a ReturnValuesMode variable is still accepted", () => {
    if (del === null) return
    const mode = "allOld" as import("../src/Entity.js").ReturnValuesMode
    const any = del.returnValues(mode)
    // Any mode compiles; the result is the model when it may be "allOld".
    expectTypeOf<User | undefined>().toMatchTypeOf<ValueOf<typeof any>>()
  })

  it("delete and deleteIfExists declare DeleteAppliedButUnreadable", () => {
    type ErrorOf<T> = T extends {
      readonly asEffect: () => import("effect").Effect.Effect<any, infer E, any>
    }
      ? E
      : never
    type TagsOf<E> = E extends { readonly _tag: infer Tag } ? Tag : never
    type IfExists = ReturnType<UserBound["deleteIfExists"]>
    expectTypeOf<
      "DeleteAppliedButUnreadable" extends TagsOf<ErrorOf<Delete>> ? true : false
    >().toEqualTypeOf<true>()
    expectTypeOf<
      "DeleteAppliedButUnreadable" extends TagsOf<ErrorOf<IfExists>> ? true : false
    >().toEqualTypeOf<true>()
  })

  it("unbound Entity.returnValues types a delete too", () => {
    const allOld = Entity.returnValues(UserEntity.delete({ userId: "u-1" }), "allOld")
    expectTypeOf<ValueOf<typeof allOld>>().toEqualTypeOf<User | undefined>()
  })
})

// ---------------------------------------------------------------------------
// `returnValues(mode)` types what the update returns (#133)
// ---------------------------------------------------------------------------

describe("Entity types — update returnValues", () => {
  type UserBound = import("../src/Entity.js").BoundEntity<
    typeof User,
    typeof UserEntity.indexes,
    undefined,
    { readonly userId: string }
  >
  type Update = ReturnType<UserBound["update"]>
  type ValueOf<T> = T extends {
    readonly asEffect: () => import("effect").Effect.Effect<infer A, any, any>
  }
    ? A
    : never
  type ErrorOf<T> = T extends {
    readonly asEffect: () => import("effect").Effect.Effect<any, infer E, any>
  }
    ? E
    : never
  type TagsOf<E> = E extends { readonly _tag: infer Tag } ? Tag : never
  // Never executed — the update descriptors only feed `typeof`.
  const update = null as unknown as Update

  it("the default and the whole-item modes return the model", () => {
    if (update === null) return
    expectTypeOf<ValueOf<Update>>().toEqualTypeOf<User>()
    expectTypeOf<ValueOf<ReturnType<typeof update.returnValues<"allNew">>>>().toEqualTypeOf<User>()
    const allOld = update.returnValues("allOld")
    expectTypeOf<ValueOf<typeof allOld>>().toEqualTypeOf<User>()
  })

  it('"none" returns undefined', () => {
    if (update === null) return
    const none = update.returnValues("none")
    expectTypeOf<ValueOf<typeof none>>().toEqualTypeOf<undefined>()
  })

  it('"updatedOld" / "updatedNew" return a partial model', () => {
    if (update === null) return
    const updatedOld = update.returnValues("updatedOld")
    const updatedNew = update.returnValues("updatedNew")
    expectTypeOf<ValueOf<typeof updatedOld>>().toEqualTypeOf<Partial<User>>()
    expectTypeOf<ValueOf<typeof updatedNew>>().toEqualTypeOf<Partial<User>>()
  })

  it("the mode survives later combinators and can be changed again", () => {
    if (update === null) return
    const thenSet = update.returnValues("none").set({ displayName: "x" })
    expectTypeOf<ValueOf<typeof thenSet>>().toEqualTypeOf<undefined>()
    const back = update.returnValues("none").returnValues("allNew")
    expectTypeOf<ValueOf<typeof back>>().toEqualTypeOf<User>()
  })

  it("the error channel declares the update concurrency errors", () => {
    expectTypeOf<
      "ConcurrentModification" extends TagsOf<ErrorOf<Update>> ? true : false
    >().toEqualTypeOf<true>()
    expectTypeOf<
      "UpdateAppliedButUnreadable" extends TagsOf<ErrorOf<Update>> ? true : false
    >().toEqualTypeOf<true>()
  })

  it("unbound Entity.returnValues types the terminals", () => {
    const none = Entity.returnValues(UserEntity.update({ userId: "u-1" }), "none")
    expectTypeOf<ValueOf<typeof none>>().toEqualTypeOf<undefined>()
    type Native<T> = T extends import("effect").Effect.Effect<infer A, any, any> ? A : never
    expectTypeOf<
      Native<ReturnType<typeof Entity.asNative<typeof none>>>
    >().toEqualTypeOf<undefined>()
    const partial = UserEntity.update({ userId: "u-1" }).pipe(Entity.returnValues("updatedNew"))
    expectTypeOf<ValueOf<typeof partial>>().toEqualTypeOf<Partial<User>>()
    // A later mode overrides an earlier one — as at runtime — through other
    // combinators in between, data-first or data-last.
    const again = Entity.returnValues(Entity.set(none, { displayName: "x" }), "allNew")
    expectTypeOf<ValueOf<typeof again>>().toEqualTypeOf<User>()
    const piped = UserEntity.update({ userId: "u-1" }).pipe(
      Entity.returnValues("none"),
      Entity.set({ displayName: "x" }),
      Entity.returnValues("updatedOld"),
    )
    expectTypeOf<ValueOf<typeof piped>>().toEqualTypeOf<Partial<User>>()
    type Rec<T> = T extends import("../src/Entity.js").EntityUpdate<any, infer R, any, any, any>
      ? R
      : never
    expectTypeOf<Rec<typeof again>>().toEqualTypeOf<Rec<ReturnType<typeof UserEntity.update>>>()
    const full = UserEntity.update({ userId: "u-1" })
    expectTypeOf<Native<ReturnType<typeof Entity.asNative<typeof full>>>>().toEqualTypeOf<
      Record<string, import("@aws-sdk/client-dynamodb").AttributeValue>
    >()
  })
})

// ---------------------------------------------------------------------------
// Packed fields (#147) — PathBuilder typing
// ---------------------------------------------------------------------------

describe("packed fields — type level", () => {
  class Shipment extends Schema.Class<Shipment>("Shipment")({
    shipmentId: Schema.String,
    carrier: Schema.String,
    parcels: Schema.Array(Schema.Struct({ weight: Schema.Number })),
    address: Schema.Struct({ city: Schema.String }),
  }) {}

  const Shipments = Entity.make({
    model: DynamoModel.configure(Shipment, {
      parcels: { storedAs: DynamoModel.Packed({ format: "json" }) },
      address: {
        storedAs: DynamoModel.Packed({ format: "json", compression: { codec: "zstd" } }),
      },
    }),
    entityType: "Shipment",
    primaryKey: {
      pk: { field: "pk", composite: ["shipmentId"] },
      sk: { field: "sk", composite: [] },
    },
  })

  it("carries the packed field names", () => {
    expectTypeOf(Shipments._packedFields).toEqualTypeOf<ReadonlyArray<"parcels" | "address">>()
    expectTypeOf(UserEntity._packedFields).toEqualTypeOf<ReadonlyArray<never>>()
  })

  it("a packed field's path is a PackedPath: exists / notExists / select only", () => {
    Shipments.condition((t, { exists, notExists, and, eq }) =>
      and(exists(t.parcels), notExists(t.address), eq(t.carrier, "dhl")),
    )
    Shipments.select((t) => [t.parcels, t.carrier])
    // Each refused at runtime too ([EDD-9076]) — the throw is not the point here.
    expect(() =>
      Shipments.condition((t, { eq }) =>
        // @ts-expect-error — a packed field is not a comparable Path
        eq(t.parcels, []),
      ),
    ).toThrow()
    expect(() =>
      Shipments.filter((t, { beginsWith }) =>
        // @ts-expect-error — no nested property on a packed field
        beginsWith(t.address.city, "M"),
      ),
    ).toThrow()
    expect(() =>
      Shipments.filter((t, { contains }) =>
        // @ts-expect-error — contains() needs a Path
        contains(t.parcels, 1),
      ),
    ).toThrow()
    expect(() =>
      Shipments.condition((t, { gt }) =>
        // @ts-expect-error — a packed field is not an ordered Path
        gt(t.parcels, 1),
      ),
    ).toThrow()
    expect(() =>
      Shipments.condition((t, { gt }) =>
        // @ts-expect-error — no .size() on a packed field
        gt(t.parcels.size(), 1),
      ),
    ).toThrow()
    // @ts-expect-error — no .at() on a packed array field
    expect(() => Shipments.select((t) => [t.parcels.at(0)])).toThrow()
    // A non-packed entity's object field keeps its nested paths.
    UserEntity.condition((t, { eq }) => eq(t.email, "x"))
  })

  it("configure refuses Packed on a scalar field", () => {
    DynamoModel.configure(Shipment, {
      // @ts-expect-error — a scalar field cannot be packed
      carrier: { storedAs: DynamoModel.Packed({ format: "json" }) },
    })
  })

  it("Entity.Marshalled admits binary (a compressed packed value)", () => {
    expectTypeOf<Entity.Marshalled<typeof Shipments>[string]["B"]>().toEqualTypeOf<
      Uint8Array | undefined
    >()
  })
})

// ---------------------------------------------------------------------------
// .within() on composite accessors (#171)
// ---------------------------------------------------------------------------

describe("Entity types — .within() (#171)", () => {
  class Listing extends Schema.Class<Listing>("Listing")({
    storeId: Schema.String,
    listingId: Schema.String,
    status: Schema.Literals(["active", "sold"]),
    price: Schema.Number,
  }) {}

  const Listings = Entity.make({
    model: Listing,
    entityType: "Listing",
    primaryKey: {
      pk: { field: "pk", composite: ["listingId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byStore: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["storeId"] },
        sk: { field: "gsi1sk", composite: ["status", "price", "listingId"] },
      },
    },
  })
  const ListingsTable = Table.make({ schema: AppSchema, entities: { Listings } })
  const makeDb = () => DynamoClient.make({ entities: { Listings }, tables: { ListingsTable } })
  // Never executed — the client only feeds `typeof`.
  const db = null as unknown as Effect.Success<ReturnType<typeof makeDb>>
  type Has<T, K extends string> = K extends keyof T ? true : false

  it("is offered while a sort key composite is open, with each bound in its own type", () => {
    if (db === null) return
    const query = db.entities.Listings.byStore({ storeId: "s-1" })
    type Bounds = Parameters<typeof query.within>[0]
    expectTypeOf<Bounds["price"]>().toEqualTypeOf<RangeBound<number> | undefined>()
    // String literal unions widen to `string`, as `.where()` operands do.
    expectTypeOf<Bounds["status"]>().toEqualTypeOf<RangeBound<string> | undefined>()
    expectTypeOf<Bounds["listingId"]>().toEqualTypeOf<RangeBound<string> | undefined>()
    expectTypeOf<keyof Bounds>().toEqualTypeOf<"status" | "price" | "listingId">()
    // Only the composites the accessor left open.
    const narrowed = db.entities.Listings.byStore({ storeId: "s-1", status: "active" })
    expectTypeOf<keyof Parameters<typeof narrowed.within>[0]>().toEqualTypeOf<
      "price" | "listingId"
    >()
  })

  it("rejects bounds that aren't a composite's or aren't one bound shape", () => {
    if (db === null) return
    const query = db.entities.Listings.byStore({ storeId: "s-1" })
    query.within({ price: { gte: 1, lt: 9 } })
    query.within({ price: { between: [1, 9] }, status: { eq: "sold" } })
    // @ts-expect-error a number composite takes numbers
    query.within({ price: { gte: "1" } })
    // @ts-expect-error a partition key composite is the accessor's
    query.within({ storeId: { eq: "s-2" } })
    // @ts-expect-error `lt` and `lte` together are not one bound
    query.within({ price: { lt: 1, lte: 2 } })
    // @ts-expect-error `eq` is not combined with another operator
    query.within({ price: { eq: 1, gte: 2 } })
  })

  it("is absent when every composite is pinned, on scans and on indexes without composites", () => {
    if (db === null) return
    const pinned = db.entities.Listings.byStore({
      storeId: "s-1",
      status: "active",
      price: 1,
      listingId: "l-1",
    })
    expectTypeOf<Has<typeof pinned, "within">>().toEqualTypeOf<false>()
    expectTypeOf<
      Has<ReturnType<typeof db.entities.Listings.scan>, "within">
    >().toEqualTypeOf<false>()
    const primary = db.entities.Listings.primary({ listingId: "l-1" })
    expectTypeOf<Has<typeof primary, "within">>().toEqualTypeOf<false>()
  })

  it("excludes .where(), and applies once", () => {
    if (db === null) return
    const query = db.entities.Listings.byStore({ storeId: "s-1" })
    const within = query.within({ price: { gte: 1 } })
    expectTypeOf<Has<typeof within, "where">>().toEqualTypeOf<false>()
    expectTypeOf<Has<typeof within, "within">>().toEqualTypeOf<false>()
    const where = query.where((t, { eq }) => eq(t.status, "active"))
    expectTypeOf<Has<typeof where, "within">>().toEqualTypeOf<false>()
    // Combinators before it keep it offered.
    const limited = query.limit(5).reverse().filter({ status: "active" })
    expectTypeOf<Has<typeof limited, "within">>().toEqualTypeOf<true>()
  })

  it("explain describes the plan without I/O", () => {
    if (db === null) return
    const explain = db.entities.Listings.byStore({ storeId: "s-1" })
      .within({ price: { gte: 1 } })
      .explain()
    expectTypeOf(explain).toEqualTypeOf<Effect.Effect<Query.QueryExplain, never, never>>()
  })
})

// ---------------------------------------------------------------------------
// Z-order sort keys (#171)
// ---------------------------------------------------------------------------

describe("Entity types — Z-order sort keys (#171)", () => {
  class Listing extends Schema.Class<Listing>("Listing")({
    listingId: Schema.String,
    region: Schema.String,
    agencyId: Schema.String,
    officeId: Schema.String,
    price: Schema.Number,
    bedrooms: Schema.Number,
  }) {}

  const facets = [
    { field: "price", min: 0, max: 5_000_000, step: 1_000 },
    { field: "bedrooms", min: 0, max: 15 },
  ] as const

  const Listings = Entity.make({
    model: Listing,
    entityType: "Listing",
    primaryKey: {
      pk: { field: "pk", composite: ["listingId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byFacets: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["region"] },
        sk: { field: "gsi1sk", zorder: facets },
      },
      byAgency: {
        name: "gsi2",
        pk: { field: "gsi2pk", composite: ["region"] },
        sk: {
          field: "gsi2sk",
          prefix: ["agencyId", { field: "officeId", hash: 8 }],
          zorder: facets,
        },
      },
    },
  })
  const ListingsTable = Table.make({ schema: AppSchema, entities: { Listings } })
  const makeDb = () => DynamoClient.make({ entities: { Listings }, tables: { ListingsTable } })
  // Never executed — the client only feeds `typeof`.
  const db = null as unknown as Effect.Success<ReturnType<typeof makeDb>>
  type Has<T, K extends string> = K extends keyof T ? true : false

  it("derives the half's composite: prefix composites, then dimensions, in order", () => {
    type Facets = typeof Listings.indexes.byFacets.sk.composite
    type Agency = typeof Listings.indexes.byAgency.sk.composite
    expectTypeOf<Facets["length"]>().toEqualTypeOf<2>()
    expectTypeOf<[Facets[0], Facets[1]]>().toEqualTypeOf<["price", "bedrooms"]>()
    expectTypeOf<Agency["length"]>().toEqualTypeOf<4>()
    expectTypeOf<[Agency[0], Agency[1], Agency[2], Agency[3]]>().toEqualTypeOf<
      ["agencyId", "officeId", "price", "bedrooms"]
    >()
  })

  it("the accessor takes the partition key composites only", () => {
    type Input = IndexPkInput<typeof Listing, typeof Listings.indexes, "byAgency">
    expectTypeOf<keyof Input>().toEqualTypeOf<"region">()
    // @ts-expect-error a dimension feeds the Z-order key: bound it, don't pin it
    const _dimension: Input = { region: "north", price: 250_000 }
    // @ts-expect-error a prefix composite feeds the Z-order key too
    const _prefix: Input = { region: "north", agencyId: "ag-1" }
    if (db === null) return
    db.entities.Listings.byFacets({ region: "north" })
    // A dimension or prefix composite passed anyway is refused at run time
    // ([EDD-9093], ZOrderEntity.test.ts): the accessor's input has none.
    // @ts-expect-error the partition key composite is required
    db.entities.Listings.byFacets({})
  })

  it("offers no .where() on a Z-order accessor", () => {
    if (db === null) return
    const query = db.entities.Listings.byFacets({ region: "north" })
    expectTypeOf<Has<typeof query, "where">>().toEqualTypeOf<false>()
    expectTypeOf<Has<typeof query, "collect">>().toEqualTypeOf<true>()
  })

  it("zorder / prefix are sort key declarations only", () => {
    expect(() =>
      Entity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: {
          pk: { field: "pk", composite: ["listingId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byFacets: {
            name: "gsi1",
            // @ts-expect-error a partition key is never a Z-order address
            pk: { field: "gsi1pk", composite: [], zorder: facets },
            sk: { field: "gsi1sk", composite: [] },
          },
        },
      }),
    ).toThrow(/\[EDD-9086\]/)
    expect(() =>
      Entity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: {
          pk: { field: "pk", composite: ["listingId"] },
          // @ts-expect-error the primary key is string-composed
          sk: { field: "sk", composite: [], zorder: facets },
        },
      }),
    ).toThrow(/\[EDD-9086\]/)
    expect(() =>
      Entity.make({
        model: Listing,
        entityType: "Listing",
        primaryKey: {
          pk: { field: "pk", composite: ["listingId"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byAgency: {
            name: "gsi1",
            // @ts-expect-error prefix belongs to the sort key half
            pk: { field: "gsi1pk", composite: ["region"], prefix: ["agencyId"] },
            sk: { field: "gsi1sk", zorder: facets },
          },
        },
      }),
    ).toThrow(/\[EDD-9086\]/)
  })

  it(".within() bounds each dimension in its own type; prefix composites take a value", () => {
    if (db === null) return
    type Bounds = Parameters<ReturnType<typeof db.entities.Listings.byAgency>["within"]>[0]
    expectTypeOf<keyof Bounds>().toEqualTypeOf<"agencyId" | "officeId" | "price" | "bedrooms">()
    expectTypeOf<NonNullable<Bounds["price"]>>().toEqualTypeOf<
      DimensionBound<(typeof facets)[0], number>
    >()
    expectTypeOf<NonNullable<Bounds["price"]>>().toEqualTypeOf<RangeBound<number>>()
    const query = db.entities.Listings.byAgency({ region: "north" })
    query.within({ agencyId: "ag-1", price: { lte: 500_000 }, bedrooms: { between: [2, 4] } })
    query.within({})
    // @ts-expect-error a prefix composite takes one exact value, not a range
    query.within({ agencyId: { gte: "ag-1" } })
    // @ts-expect-error `in` bounds only a literals dimension
    query.within({ price: { in: [1, 2] } })
    // @ts-expect-error the bound is in the field's own type
    query.within({ price: { gte: "1" } })
    // @ts-expect-error the partition key composite belongs to the accessor
    query.within({ region: "south" })
  })

  it(".zorder() only on a Z-order accessor, before or after .within()", () => {
    if (db === null) return
    const query = db.entities.Listings.byFacets({ region: "north" })
    expectTypeOf<Has<typeof query, "zorder">>().toEqualTypeOf<true>()
    const within = query.zorder({ strategy: "jump" }).within({ price: { gte: 1 } })
    expectTypeOf<Has<typeof within, "zorder">>().toEqualTypeOf<true>()
    // One `.within()` per query; `.where()` never.
    expectTypeOf<Has<typeof within, "within">>().toEqualTypeOf<false>()
    expectTypeOf<Has<typeof within, "where">>().toEqualTypeOf<false>()
    const tuned = within.zorder({ maxRanges: 32, concurrency: 2, pageSize: 50 }).limit(5)
    expectTypeOf<Has<typeof tuned, "zorder">>().toEqualTypeOf<true>()
    expectTypeOf<Effect.Success<ReturnType<typeof tuned.collect>>>().toEqualTypeOf<Array<Listing>>()
    // Each option takes an explicit `undefined` (exactOptionalPropertyTypes): unset.
    const configured: number | undefined = undefined
    query.zorder({ strategy: undefined, pageSize: configured, maxRanges: undefined })
    query.zorder({ concurrency: configured })
    // @ts-expect-error not a strategy
    query.zorder({ strategy: "sideways" })
    // Neither a scan nor the primary accessor has a Z-order sort key.
    expectTypeOf<
      Has<ReturnType<typeof db.entities.Listings.scan>, "zorder">
    >().toEqualTypeOf<false>()
    const primary = db.entities.Listings.primary({ listingId: "l-1" })
    expectTypeOf<Has<typeof primary, "zorder">>().toEqualTypeOf<false>()
  })

  it("a four-dimension key: number, date, literals and a prefix, each bounded in kind", () => {
    class Home extends Schema.Class<Home>("Home")({
      homeId: Schema.String,
      region: Schema.String,
      agencyId: Schema.String,
      price: Schema.Number,
      bedrooms: Schema.Number,
      listedAt: Schema.DateTimeUtc,
      status: Schema.Literals(["draft", "live", "sold"]),
    }) {}
    const statusDim = { field: "status", values: ["draft", "live", "sold"] } as const
    const Homes = Entity.make({
      model: Home,
      entityType: "Home",
      primaryKey: {
        pk: { field: "pk", composite: ["homeId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        byMarket: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["region"] },
          sk: {
            field: "gsi1sk",
            prefix: ["agencyId"],
            zorder: [
              facets[0],
              facets[1],
              { field: "listedAt", from: "2024-01-01", unit: "hours", bits: 16 },
              statusDim,
            ],
          },
        },
      },
    })
    const HomesTable = Table.make({ schema: AppSchema, entities: { Homes } })
    const makeHomes = () => DynamoClient.make({ entities: { Homes }, tables: { HomesTable } })
    const homes = null as unknown as Effect.Success<ReturnType<typeof makeHomes>>
    type Bounds = Parameters<ReturnType<typeof homes.entities.Homes.byMarket>["within"]>[0]
    expectTypeOf<keyof Bounds>().toEqualTypeOf<
      "agencyId" | "price" | "bedrooms" | "listedAt" | "status"
    >()
    expectTypeOf<NonNullable<Bounds["agencyId"]>>().toEqualTypeOf<string>()
    expectTypeOf<NonNullable<Bounds["listedAt"]>>().toEqualTypeOf<RangeBound<DateTime.Utc>>()
    expectTypeOf<NonNullable<Bounds["status"]>>().toEqualTypeOf<
      | RangeBound<"draft" | "live" | "sold">
      | ({ readonly in: ReadonlyArray<"draft" | "live" | "sold"> } & {
          readonly eq?: never
          readonly between?: never
          readonly gt?: never
          readonly gte?: never
          readonly lt?: never
          readonly lte?: never
        })
    >()
    if (homes === null) return
    const market = homes.entities.Homes.byMarket({ region: "north" })
    market.within({
      status: { in: ["live", "sold"] },
      listedAt: { gte: null as unknown as DateTime.Utc },
    })
    market.within({ status: { gte: "live" } })
    // @ts-expect-error not a declared literal
    market.within({ status: { eq: "archived" } })
    // @ts-expect-error a date dimension takes the field's DateTime
    market.within({ listedAt: { gte: 1_700_000_000 } })
  })

  it("an entry's options follow its field's type", () => {
    type Fields = { price: number; listedAt: DateTime.Utc; status: "draft" | "live"; title: string }
    expectTypeOf<ZOrder.DimensionFor<"price", number>>().toEqualTypeOf<
      ZOrder.NumericDimension<"price">
    >()
    expectTypeOf<ZOrder.DimensionFor<"listedAt", DateTime.Utc>>().toEqualTypeOf<
      ZOrder.DateTimeDimension<"listedAt">
    >()
    expectTypeOf<ZOrder.DimensionFor<"status", "draft" | "live">>().toEqualTypeOf<
      | "status"
      | ZOrder.LiteralsDimension<"status", "draft" | "live">
      | ZOrder.StringDimension<"status">
    >()
    expectTypeOf<ZOrder.DimensionFor<"title", string>>().toEqualTypeOf<
      ZOrder.StringDimension<"title"> | ZOrder.ListedLiteralsDimension<"title", string>
    >()
    expectTypeOf<ZOrder.DimensionFor<"open", boolean>>().toEqualTypeOf<
      "open" | ZOrder.LiteralsDimension<"open", boolean>
    >()
    expectTypeOf<{ field: "price"; min: 0; max: 9 }>().toMatchTypeOf<ZOrder.Dimension<Fields>>()
    expectTypeOf<"status">().toMatchTypeOf<ZOrder.Dimension<Fields>>()
    // A bare name takes literal members only; a range takes a number field only.
    expectTypeOf<"title">().not.toMatchTypeOf<ZOrder.Dimension<Fields>>()
    expectTypeOf<{ field: "title"; min: 0; max: 9 }>().not.toMatchTypeOf<ZOrder.Dimension<Fields>>()
  })
})
