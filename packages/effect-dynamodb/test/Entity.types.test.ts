/**
 * Type-level tests for Entity type extractors.
 * Uses vitest's `expectTypeOf` to verify compile-time type relationships.
 */

import { type DateTime, Schema } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as DynamoModel from "../src/DynamoModel.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import type { IndexPkInput } from "../src/internal/EntityTypes.js"
import type * as Query from "../src/Query.js"
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

  it("rejects primary index with both pk and sk composites empty", () => {
    expect(() =>
      Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: [] as const },
          sk: { field: "sk", composite: [] as const },
        },
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
    expect(() =>
      Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          // @ts-expect-error — "nonExistent" is not a field on User
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
    expectTypeOf<BrandedPlayerId>().toMatchTypeOf<PlayerIdField>()

    // Mixed pk: ref-renamed composite + regular model fields all required.
    expectTypeOf<SquadByTeamSeries>().toHaveProperty("teamId")
    expectTypeOf<SquadByTeamSeries>().toHaveProperty("season")
    expectTypeOf<SquadByTeamSeries>().toHaveProperty("series")
    type TeamIdField = SquadByTeamSeries["teamId"]
    expectTypeOf<BrandedTeamId>().toMatchTypeOf<TeamIdField>()

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
