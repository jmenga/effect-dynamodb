/**
 * Type-level tests for Entity type extractors.
 * Uses vitest's `expectTypeOf` to verify compile-time type relationships.
 */

import { type DateTime, Schema } from "effect"
import { describe, expectTypeOf, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

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
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: [] },
    },
    byRole: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["role"] },
      sk: { field: "gsi1sk", composite: ["userId"] },
    },
  },
})

/** Entity with timestamps + versioning */
const VersionedUserEntity = Entity.make({
  model: User,
  entityType: "VersionedUser",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: [] },
    },
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
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["orgId"] },
      sk: { field: "sk", composite: ["userId"] },
    },
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
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["teamId"] },
      sk: { field: "sk", composite: [] },
    },
  },
})

const PlayerEntity = Entity.make({
  model: Player,
  entityType: "Player",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["playerId"] },
      sk: { field: "sk", composite: [] },
    },
  },
})

const SelectionEntity = Entity.make({
  model: Selection,
  entityType: "Selection",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["selectionId"] },
      sk: { field: "sk", composite: [] },
    },
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
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  },
})

const BrandedPlayerEntity = Entity.make({
  model: DynamoModel.configure(BrandedPlayer, {
    id: { field: "playerId", identifier: true },
  }),
  entityType: "BrandedPlayer",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  },
})

const BrandedSelectionEntity = Entity.make({
  model: DynamoModel.configure(BrandedSelection, {
    id: { field: "selectionId", identifier: true },
    team: { ref: true },
    player: { ref: true },
  }),
  entityType: "BrandedSelection",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["id"] },
      sk: { field: "sk", composite: [] },
    },
  },
  refs: {
    team: { entity: BrandedTeamEntity },
    player: { entity: BrandedPlayerEntity },
  },
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
    expectTypeOf<UserUpdate>().toMatchTypeOf<{
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
    expectTypeOf<MemberUpdate>().toMatchTypeOf<{
      role?: "owner" | "admin" | "member"
    }>()

    // Both pk and sk composites should be excluded
    expectTypeOf<MemberUpdate>().not.toHaveProperty("orgId")
    expectTypeOf<MemberUpdate>().not.toHaveProperty("userId")
  })

  it("Entity.Update replaces ref fields with optional Id fields for ref-aware entities", () => {
    type SelectionUpdate = Entity.Update<typeof SelectionEntity>

    // Non-key, non-ref field is optional
    expectTypeOf<SelectionUpdate>().toMatchTypeOf<{
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
    expectTypeOf<UserMarshalled>().toMatchTypeOf<
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

    // PK composite should be excluded
    expectTypeOf<UserCreate>().not.toHaveProperty("userId")
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

  it("createSchema type is Entity.Input minus PK composites", () => {
    type CreateSchemaType = Schema.Schema.Type<typeof UserEntity.createSchema>

    // Should have non-PK fields
    expectTypeOf<CreateSchemaType>().toHaveProperty("email")
    expectTypeOf<CreateSchemaType>().toHaveProperty("displayName")
    expectTypeOf<CreateSchemaType>().toHaveProperty("role")

    // Primary key should be excluded
    expectTypeOf<CreateSchemaType>().not.toHaveProperty("userId")
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
})
