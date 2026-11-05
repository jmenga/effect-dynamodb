import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
import { Config, ConfigProvider, DateTime, Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"
import * as Aggregate from "../src/Aggregate.js"
import { classifyError, composeRangeUnder, DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import type { SkConditionOps } from "../src/internal/BoundQuery.js"
import { keyJustBelow } from "../src/internal/RangePlanner.js"
import * as Table from "../src/Table.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"
import * as ZListings from "./helpers/ZOrderListings.js"

const configFromMap = (entries: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(entries))

// Create a mock DynamoClient layer for testing
const mockPutItem = vi.fn()
const mockGetItem = vi.fn()
const mockDeleteItem = vi.fn()
const mockUpdateItem = vi.fn()
const mockQuery = vi.fn()

const TestDynamoClient = mockDynamoClientLayer({
  putItem: (input) =>
    Effect.tryPromise({
      try: () => mockPutItem(input),
      catch: (e) => new DynamoError({ operation: "PutItem", cause: e }),
    }),
  getItem: (input) =>
    Effect.tryPromise({
      try: () => mockGetItem(input),
      catch: (e) => new DynamoError({ operation: "GetItem", cause: e }),
    }),
  deleteItem: (input) =>
    Effect.tryPromise({
      try: () => mockDeleteItem(input),
      catch: (e) => new DynamoError({ operation: "DeleteItem", cause: e }),
    }),
  updateItem: (input) =>
    Effect.tryPromise({
      try: () => mockUpdateItem(input),
      catch: (e) => new DynamoError({ operation: "UpdateItem", cause: e }),
    }),
  query: (input) =>
    Effect.tryPromise({
      try: () => mockQuery(input),
      catch: (e) => new DynamoError({ operation: "Query", cause: e }),
    }),
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe("DynamoClient", () => {
  it.effect("putItem delegates to underlying client", () =>
    Effect.gen(function* () {
      const client = yield* DynamoClient
      mockPutItem.mockResolvedValueOnce({})
      yield* client.putItem({ TableName: "test", Item: {} })
      expect(mockPutItem).toHaveBeenCalledOnce()
    }).pipe(Effect.provide(TestDynamoClient)),
  )

  it.effect("getItem delegates to underlying client", () =>
    Effect.gen(function* () {
      const client = yield* DynamoClient
      mockGetItem.mockResolvedValueOnce({ Item: { pk: { S: "test" } } })
      const result = yield* client.getItem({ TableName: "test", Key: {} })
      expect(result.Item).toBeDefined()
    }).pipe(Effect.provide(TestDynamoClient)),
  )

  it.effect("updateItem delegates to underlying client", () =>
    Effect.gen(function* () {
      const client = yield* DynamoClient
      mockUpdateItem.mockResolvedValueOnce({ Attributes: { pk: { S: "test" } } })
      const result = yield* client.updateItem({
        TableName: "test",
        Key: {},
        UpdateExpression: "SET #n = :v",
        ExpressionAttributeNames: { "#n": "name" },
        ExpressionAttributeValues: { ":v": { S: "updated" } },
      })
      expect(result.Attributes).toBeDefined()
    }).pipe(Effect.provide(TestDynamoClient)),
  )

  it.effect("wraps SDK errors as DynamoError", () =>
    Effect.gen(function* () {
      const client = yield* DynamoClient
      mockPutItem.mockRejectedValueOnce(new Error("connection refused"))
      const error = yield* client.putItem({ TableName: "test", Item: {} }).pipe(Effect.flip)
      expect(error._tag).toBe("DynamoError")
      expect(error.operation).toBe("PutItem")
    }).pipe(Effect.provide(TestDynamoClient)),
  )

  describe("layerConfig", () => {
    it.effect("creates layer from Config values", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        // Client was constructed successfully — verify service is accessible
        expect(client.putItem).toBeDefined()
        expect(client.getItem).toBeDefined()
        expect(client.query).toBeDefined()
      }).pipe(
        Effect.provide(
          DynamoClient.layerConfig({
            region: Config.String("AWS_REGION"),
            endpoint: Config.String("DYNAMODB_ENDPOINT"),
          }),
        ),
        Effect.provide(
          configFromMap({ AWS_REGION: "us-west-2", DYNAMODB_ENDPOINT: "http://localhost:8000" }),
        ),
      ),
    )

    it.effect("fails with ConfigError when required config is missing", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        expect(client).toBeUndefined() // Should not reach here
      }).pipe(
        Effect.provide(DynamoClient.layerConfig({ region: Config.String("MISSING_REGION") })),
        Effect.provide(configFromMap({})),
        Effect.flip,
        Effect.tap((error) => Effect.sync(() => expect(error._tag).toBe("ConfigError"))),
      ),
    )

    it.effect("layerConfig with only region (no endpoint)", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        expect(client.putItem).toBeDefined()
        expect(client.getItem).toBeDefined()
      }).pipe(
        Effect.provide(DynamoClient.layerConfig({ region: Config.String("AWS_REGION") })),
        Effect.provide(configFromMap({ AWS_REGION: "eu-west-1" })),
      ),
    )
  })

  describe("error scenarios", () => {
    it.effect("getItem wraps errors with correct operation name", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        mockGetItem.mockRejectedValueOnce(new Error("throttled"))
        const error = yield* client.getItem({ TableName: "t", Key: {} }).pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        expect(error.operation).toBe("GetItem")
        expect((error.cause as Error).message).toBe("throttled")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("deleteItem wraps errors with correct operation name", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        mockDeleteItem.mockRejectedValueOnce(new Error("access denied"))
        const error = yield* client.deleteItem({ TableName: "t", Key: {} }).pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        expect(error.operation).toBe("DeleteItem")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("updateItem wraps errors with correct operation name", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        mockUpdateItem.mockRejectedValueOnce(new Error("validation failed"))
        const error = yield* client
          .updateItem({
            TableName: "t",
            Key: {},
            UpdateExpression: "SET #n = :v",
            ExpressionAttributeNames: { "#n": "name" },
            ExpressionAttributeValues: { ":v": { S: "x" } },
          })
          .pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        expect(error.operation).toBe("UpdateItem")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("query wraps errors with correct operation name", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        mockQuery.mockRejectedValueOnce(new Error("resource not found"))
        const error = yield* client
          .query({ TableName: "t", KeyConditionExpression: "#pk = :pk" })
          .pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        expect(error.operation).toBe("Query")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("DynamoError preserves original cause", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const originalError = new Error("ConditionalCheckFailedException")
        ;(originalError as any).name = "ConditionalCheckFailedException"
        mockPutItem.mockRejectedValueOnce(originalError)

        const error = yield* client.putItem({ TableName: "t", Item: {} }).pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        expect(error.cause).toBe(originalError)
        expect((error.cause as Error).name).toBe("ConditionalCheckFailedException")
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  describe("delegation", () => {
    it.effect("deleteItem delegates to underlying client", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        mockDeleteItem.mockResolvedValueOnce({})
        yield* client.deleteItem({ TableName: "test", Key: { pk: { S: "k" } } })
        expect(mockDeleteItem).toHaveBeenCalledOnce()
        const call = mockDeleteItem.mock.calls[0]![0]
        expect(call.TableName).toBe("test")
      }).pipe(Effect.provide(TestDynamoClient)),
    )

    it.effect("query delegates to underlying client", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        mockQuery.mockResolvedValueOnce({ Items: [], Count: 0 })
        const result = yield* client.query({
          TableName: "test",
          KeyConditionExpression: "#pk = :pk",
        })
        expect(result.Items).toEqual([])
        expect(mockQuery).toHaveBeenCalledOnce()
      }).pipe(Effect.provide(TestDynamoClient)),
    )
  })

  describe("error classification", () => {
    const mockClassifiedPutItem = vi.fn()

    const ClassifiedDynamoClient = mockDynamoClientLayer({
      putItem: (input) =>
        Effect.tryPromise({
          try: () => mockClassifiedPutItem(input),
          catch: classifyError("PutItem"),
        }),
    })

    it.effect("ThrottlingException produces ThrottlingError", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const awsError = Object.assign(new Error("Rate exceeded"), {
          name: "ThrottlingException",
        })
        mockClassifiedPutItem.mockRejectedValueOnce(awsError)
        const error = yield* client.putItem({ TableName: "t", Item: {} }).pipe(Effect.flip)
        expect(error._tag).toBe("ThrottlingError")
        expect(error.operation).toBe("PutItem")
        expect(error.cause).toBe(awsError)
      }).pipe(Effect.provide(ClassifiedDynamoClient)),
    )

    it.effect("ProvisionedThroughputExceededException produces ThrottlingError", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const awsError = Object.assign(new Error("Throughput exceeded"), {
          name: "ProvisionedThroughputExceededException",
        })
        mockClassifiedPutItem.mockRejectedValueOnce(awsError)
        const error = yield* client.putItem({ TableName: "t", Item: {} }).pipe(Effect.flip)
        expect(error._tag).toBe("ThrottlingError")
        expect(error.operation).toBe("PutItem")
      }).pipe(Effect.provide(ClassifiedDynamoClient)),
    )

    it.effect("ValidationException produces DynamoValidationError", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const awsError = Object.assign(new Error("Invalid request"), {
          name: "ValidationException",
        })
        mockClassifiedPutItem.mockRejectedValueOnce(awsError)
        const error = yield* client.putItem({ TableName: "t", Item: {} }).pipe(Effect.flip)
        expect(error._tag).toBe("DynamoValidationError")
        expect(error.operation).toBe("PutItem")
        expect(error.cause).toBe(awsError)
      }).pipe(Effect.provide(ClassifiedDynamoClient)),
    )

    it.effect("InternalServerError produces InternalServerError", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const awsError = Object.assign(new Error("Internal failure"), {
          name: "InternalServerError",
        })
        mockClassifiedPutItem.mockRejectedValueOnce(awsError)
        const error = yield* client.putItem({ TableName: "t", Item: {} }).pipe(Effect.flip)
        expect(error._tag).toBe("InternalServerError")
        expect(error.operation).toBe("PutItem")
        expect(error.cause).toBe(awsError)
      }).pipe(Effect.provide(ClassifiedDynamoClient)),
    )

    it.effect("ResourceNotFoundException produces ResourceNotFoundError", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const awsError = Object.assign(new Error("Table not found"), {
          name: "ResourceNotFoundException",
        })
        mockClassifiedPutItem.mockRejectedValueOnce(awsError)
        const error = yield* client.putItem({ TableName: "t", Item: {} }).pipe(Effect.flip)
        expect(error._tag).toBe("ResourceNotFoundError")
        expect(error.operation).toBe("PutItem")
        expect(error.cause).toBe(awsError)
      }).pipe(Effect.provide(ClassifiedDynamoClient)),
    )

    it.effect("unknown errors still produce DynamoError", () =>
      Effect.gen(function* () {
        const client = yield* DynamoClient
        const unknownError = new Error("something unexpected")
        mockClassifiedPutItem.mockRejectedValueOnce(unknownError)
        const error = yield* client.putItem({ TableName: "t", Item: {} }).pipe(Effect.flip)
        expect(error._tag).toBe("DynamoError")
        expect(error.operation).toBe("PutItem")
        expect(error.cause).toBe(unknownError)
      }).pipe(Effect.provide(ClassifiedDynamoClient)),
    )
  })

  // -------------------------------------------------------------------------
  // make({ tables, aggregates }) — aggregate→table merge for LSI auto-detection
  //
  // Regression guard for: aggregates passed via `DynamoClient.make({ aggregates })`
  // but NOT registered on `Table.make({ aggregates })` were silently dropped in the
  // `if (config.tables)` branch, so `db.tables.*.create()` never provisioned their
  // LSIs and downstream aggregate ops failed with "table does not have index lsi1".
  // -------------------------------------------------------------------------
  describe("make — aggregate→table LSI merge", () => {
    // Minimal reusable fixtures
    const AppSchema = DynamoSchema.make({ name: "testapp", version: 1 })

    class MatchItem extends Schema.Class<MatchItem>("MatchItem")({
      id: Schema.String,
      name: Schema.String,
    }) {}

    class Venue extends Schema.Class<Venue>("Venue")({
      venueId: Schema.String,
      name: Schema.String,
    }) {}

    const MatchItemEntity = Entity.make({
      model: MatchItem,
      entityType: "MatchItem",
      primaryKey: {
        pk: { field: "pk", composite: ["id"] },
        sk: { field: "sk", composite: [] },
      },
    })

    const VenueEntity = Entity.make({
      model: Venue,
      entityType: "Venue",
      primaryKey: {
        pk: { field: "pk", composite: ["venueId"] },
        sk: { field: "sk", composite: [] },
      },
    })

    /**
     * Build a layered DynamoClient that captures `createTable` calls into
     * the provided ref array. All other ops die (they should not be called
     * during `db.tables.*.create()`).
     */
    const makeCapturingClient = (captured: Array<unknown>) =>
      mockDynamoClientLayer({
        createTable: (input) =>
          Effect.sync(() => {
            captured.push(input)
            return {} as never
          }),
      })

    it.effect("merges config.aggregates into user-supplied table so LSIs are provisioned", () => {
      // IMPORTANT: the user does NOT register MatchAggregate on Table.make. This
      // is the circular-import workaround used by the gamemanager tutorial.
      const MainTable = Table.make({
        schema: AppSchema,
        entities: { MatchItem: MatchItemEntity },
      })

      const MatchAggregate = Aggregate.make(MatchItem, {
        table: MainTable,
        schema: AppSchema,
        pk: { field: "pk", composite: ["id"] },
        collection: {
          index: "lsi1",
          name: "match",
          sk: { field: "lsi1sk", composite: ["name"] },
        },
        root: { entityType: "MatchItem" },
        edges: {},
      })

      const captured: Array<any> = []
      const ClientLayer = makeCapturingClient(captured)
      const TableLayer = MainTable.layer({ name: "merge-test-table" })

      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { MatchItem: MatchItemEntity },
          aggregates: { MatchAggregate },
          tables: { MainTable },
        })
        yield* db.tables.MainTable.create()

        expect(captured).toHaveLength(1)
        const input = captured[0]
        expect(input.TableName).toBe("merge-test-table")

        // The LSI MUST be present — this is the regression guard.
        expect(input.LocalSecondaryIndexes).toBeDefined()
        expect(input.LocalSecondaryIndexes).toHaveLength(1)
        expect(input.LocalSecondaryIndexes[0].IndexName).toBe("lsi1")
        // LSI HASH key must match the base table's HASH key per DynamoDB rules.
        expect(input.LocalSecondaryIndexes[0].KeySchema[0]).toEqual({
          AttributeName: "pk",
          KeyType: "HASH",
        })
        expect(input.LocalSecondaryIndexes[0].KeySchema[1]).toEqual({
          AttributeName: "lsi1sk",
          KeyType: "RANGE",
        })

        // lsi1sk must appear in the attribute definitions.
        const attrNames = (input.AttributeDefinitions as Array<{ AttributeName: string }>).map(
          (a) => a.AttributeName,
        )
        expect(attrNames).toContain("lsi1sk")
      }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
    })

    it.effect(
      "without aggregates produces a createTable call with no LSI (regression guard)",
      () => {
        // Same entity/table setup but no `aggregates` on DynamoClient.make — the
        // table should come back with zero LSIs, proving the merge is the only
        // path that introduces them in the `tables` branch.
        const MainTable = Table.make({
          schema: AppSchema,
          entities: { MatchItem: MatchItemEntity },
        })

        const captured: Array<any> = []
        const ClientLayer = makeCapturingClient(captured)
        const TableLayer = MainTable.layer({ name: "no-agg-test-table" })

        return Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { MatchItem: MatchItemEntity },
            tables: { MainTable },
          })
          yield* db.tables.MainTable.create()

          expect(captured).toHaveLength(1)
          const input = captured[0]
          expect(input.TableName).toBe("no-agg-test-table")
          expect(input.LocalSecondaryIndexes).toBeUndefined()
          expect(input.GlobalSecondaryIndexes).toBeUndefined()
        }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
      },
    )

    it.effect(
      "aggregates whose _tableTag does not match any supplied table are silently skipped",
      () => {
        // MainTable is supplied; OtherTable is NOT, but the aggregate is built
        // against OtherTable. The merge loop must skip it without erroring,
        // and MainTable's createTable call must have no LSI (since no matching
        // aggregate contributes one).
        const MainTable = Table.make({
          schema: AppSchema,
          entities: { Venue: VenueEntity },
        })

        const OtherTable = Table.make({
          schema: AppSchema,
          entities: { MatchItem: MatchItemEntity },
        })

        const OrphanAggregate = Aggregate.make(MatchItem, {
          table: OtherTable, // belongs to OtherTable
          schema: AppSchema,
          pk: { field: "pk", composite: ["id"] },
          collection: {
            index: "lsi1",
            name: "match",
            sk: { field: "lsi1sk", composite: ["name"] },
          },
          root: { entityType: "MatchItem" },
          edges: {},
        })

        const captured: Array<any> = []
        const ClientLayer = makeCapturingClient(captured)
        // Only MainTable gets a layer — OtherTable's Tag is never resolved.
        const TableLayer = MainTable.layer({ name: "orphan-test-table" })

        return Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { Venue: VenueEntity },
            aggregates: { OrphanAggregate },
            tables: { MainTable },
          })
          // The orphan aggregate's LSI must NOT leak into MainTable's definition.
          yield* db.tables.MainTable.create()

          expect(captured).toHaveLength(1)
          const input = captured[0]
          expect(input.TableName).toBe("orphan-test-table")
          expect(input.LocalSecondaryIndexes).toBeUndefined()
        }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
      },
    )
  })

  // -------------------------------------------------------------------------
  // .primary() accessor — symmetric query accessor for the primary index.
  //
  // Mirrors the GSI accessor contract: required PK composites, optional SK
  // composites (prefix-ordered), returns a BoundQuery. Prior to this, the
  // primary index was excluded from accessor generation and the only way to
  // query a shared primary partition was via a raw `Query.Query` escape
  // hatch. See GH issue #2.
  // -------------------------------------------------------------------------
  describe(".primary() accessor", () => {
    const AppSchema = DynamoSchema.make({ name: "primary-accessor", version: 1 })

    class AccountChannel extends Schema.Class<AccountChannel>("AccountChannel")({
      accountId: Schema.String,
      channelId: Schema.String,
      grantedBy: Schema.String,
    }) {}

    const AccountChannelEntity = Entity.make({
      model: AccountChannel,
      entityType: "AccountChannel",
      // Shared-PK join-table pattern: many channels per account.
      primaryKey: {
        pk: { field: "pk", composite: ["accountId"] },
        sk: { field: "sk", composite: ["channelId"] },
      },
    })

    const MainTable = Table.make({
      schema: AppSchema,
      entities: { AccountChannel: AccountChannelEntity },
    })

    /** Build a client layer that captures `query` inputs into the provided array. */
    const makeQueryCapturingClient = (captured: Array<unknown>) =>
      mockDynamoClientLayer({
        query: (input) =>
          Effect.sync(() => {
            captured.push(input)
            return { Items: [], Count: 0 } as never
          }),
      })

    it.effect("PK-only query on primary targets the base table (no IndexName)", () => {
      const captured: Array<any> = []
      const ClientLayer = makeQueryCapturingClient(captured)
      const TableLayer = MainTable.layer({ name: "primary-test-table" })

      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { AccountChannel: AccountChannelEntity },
          tables: { MainTable },
        })

        yield* db.entities.AccountChannel.primary({ accountId: "acct-1" }).collect()

        expect(captured).toHaveLength(1)
        const input = captured[0]
        // Base table query — IndexName must be omitted.
        expect(input.IndexName).toBeUndefined()
        expect(input.TableName).toBe("primary-test-table")
        // KeyConditionExpression pins the partition key only.
        expect(input.KeyConditionExpression).toContain("#pk")
        expect(input.KeyConditionExpression).not.toContain("begins_with")
        expect(input.ExpressionAttributeNames["#pk"]).toBe("pk")
        // PK value is the composed entity-type-prefixed key.
        const pkValue = input.ExpressionAttributeValues[":pk"].S as string
        expect(pkValue).toContain("accountchannel")
        expect(pkValue).toContain("acct-1")
      }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
    })

    it.effect("PK + every SK composite matches the composed SK exactly", () => {
      const captured: Array<any> = []
      const ClientLayer = makeQueryCapturingClient(captured)
      const TableLayer = MainTable.layer({ name: "primary-test-table" })

      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { AccountChannel: AccountChannelEntity },
          tables: { MainTable },
        })

        yield* db.entities.AccountChannel.primary({
          accountId: "acct-1",
          channelId: "ch-42",
        }).collect()

        expect(captured).toHaveLength(1)
        const input = captured[0]
        expect(input.IndexName).toBeUndefined()
        // Every SK composite given: the key is complete, so it is matched with
        // `=`. `begins_with` on it would also match a longer channel id
        // (`ch-420`), and the item's history rows, whose keys extend it.
        expect(input.KeyConditionExpression).toBe("#pk = :pk AND #sk = :sk")
        const skValue = input.ExpressionAttributeValues[":sk"].S as string
        expect(skValue.endsWith("ch-42")).toBe(true)
      }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
    })

    it.effect(".primary() returns a BoundQuery that supports chained combinators", () => {
      const captured: Array<any> = []
      const ClientLayer = makeQueryCapturingClient(captured)
      const TableLayer = MainTable.layer({ name: "primary-test-table" })

      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { AccountChannel: AccountChannelEntity },
          tables: { MainTable },
        })

        // .filter() and .pageSize() must chain without type errors and
        // propagate to the underlying DynamoDB query input. A numeric
        // `pageSize` is sent as `Limit` as given; `.limit()` bounds the items
        // returned, and under a filter only sizes the requests from the
        // observed pass rate when no `pageSize` is set.
        yield* db.entities.AccountChannel.primary({ accountId: "acct-1" })
          .filter({ grantedBy: "admin" })
          .pageSize(5)
          .collect()

        expect(captured).toHaveLength(1)
        const input = captured[0]
        expect(input.Limit).toBe(5)
        expect(input.FilterExpression).toBeDefined()
        // Attribute names are placeholder-aliased (#e0 etc.); look up the
        // actual field via ExpressionAttributeNames values.
        expect(Object.values(input.ExpressionAttributeNames)).toContain("grantedBy")
        expect(
          Object.values(input.ExpressionAttributeValues).some((v: any) => v.S === "admin"),
        ).toBe(true)
      }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
    })

    it.effect("entities with empty SK composites query by PK only", () => {
      class User extends Schema.Class<User>("User")({
        userId: Schema.String,
        email: Schema.String,
      }) {}

      const UserEntity = Entity.make({
        model: User,
        entityType: "User",
        primaryKey: {
          pk: { field: "pk", composite: ["userId"] },
          sk: { field: "sk", composite: [] },
        },
      })

      const SimpleTable = Table.make({ schema: AppSchema, entities: { User: UserEntity } })

      const captured: Array<any> = []
      const ClientLayer = makeQueryCapturingClient(captured)
      const TableLayer = SimpleTable.layer({ name: "simple-table" })

      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { User: UserEntity },
          tables: { SimpleTable },
        })

        yield* db.entities.User.primary({ userId: "u-1" }).collect()

        expect(captured).toHaveLength(1)
        const input = captured[0]
        expect(input.IndexName).toBeUndefined()
        // No begins_with clause when the entity has no SK composites.
        expect(input.KeyConditionExpression).not.toContain("begins_with")
      }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
    })

    it.effect("missing PK composite throws at runtime via validateQueryComposites", () => {
      const ClientLayer = makeQueryCapturingClient([])
      const TableLayer = MainTable.layer({ name: "primary-test-table" })

      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { AccountChannel: AccountChannelEntity },
          tables: { MainTable },
        })

        // Calling .primary() without the required PK composite throws
        // synchronously — same contract as GSI accessors.
        expect(() =>
          // @ts-expect-error — accountId is required
          db.entities.AccountChannel.primary({}),
        ).toThrow(/EDD-9002.*accountId/)
      }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
    })
  })

  // -------------------------------------------------------------------------
  // .where() sort key conditions — issue #101
  //
  // A stored sort key is `$schema#v1#entity#<name>_<cased value>`. Before the
  // fix the `.where()` operand was concatenated raw onto the entity prefix, so
  // `gte` matched the whole partition (a raw value sorts below every
  // `<name>_`-prefixed segment) while `begins_with` / `between` matched nothing.
  // -------------------------------------------------------------------------

  describe(".where() sort key conditions", () => {
    const AppSchema = DynamoSchema.make({ name: "wheretest", version: 1 })

    /** Build a client layer that captures `query` inputs into the provided array. */
    const makeQueryCapturingClient = (captured: Array<unknown>) =>
      mockDynamoClientLayer({
        query: (input) =>
          Effect.sync(() => {
            captured.push(input)
            return { Items: [], Count: 0 } as never
          }),
      })

    // Single SK composite — the shape from issue #101.
    class Ball extends Schema.Class<Ball>("Ball")({
      matchId: Schema.String,
      ballKey: Schema.String,
    }) {}

    const Balls = Entity.make({
      model: Ball,
      entityType: "Ball",
      primaryKey: {
        pk: { field: "pk", composite: ["matchId"] },
        sk: { field: "sk", composite: ["ballKey"] },
      },
      indexes: {
        byMatch: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["matchId"] },
          sk: { field: "gsi1sk", composite: ["ballKey"] },
        },
      },
    })

    // Two SK composites — exercises the non-terminal composite path.
    class Reading extends Schema.Class<Reading>("Reading")({
      deviceId: Schema.String,
      status: Schema.String,
      seq: Schema.String,
    }) {}

    const Readings = Entity.make({
      model: Reading,
      entityType: "Reading",
      primaryKey: {
        pk: { field: "pk", composite: ["deviceId"] },
        sk: { field: "sk", composite: ["status", "seq"] },
      },
      indexes: {
        byDevice: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["deviceId"] },
          sk: { field: "gsi1sk", composite: ["status", "seq"] },
        },
      },
    })

    // Empty SK composite — `.where()` has nothing to constrain.
    class Lookup extends Schema.Class<Lookup>("Lookup")({
      lookupId: Schema.String,
      email: Schema.String,
    }) {}

    const Lookups = Entity.make({
      model: Lookup,
      entityType: "Lookup",
      primaryKey: {
        pk: { field: "pk", composite: ["lookupId"] },
        sk: { field: "sk", composite: [] },
      },
      indexes: {
        byEmail: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["email"] },
          sk: { field: "gsi1sk", composite: [] },
        },
      },
    })

    const WhereTable = Table.make({
      schema: AppSchema,
      entities: { Balls, Readings, Lookups },
    })

    const makeWhereDb = () =>
      DynamoClient.make({ entities: { Balls, Readings, Lookups }, tables: { WhereTable } })
    type WhereDb = Effect.Success<ReturnType<typeof makeWhereDb>>

    /** Run a `.where()` query and return every captured DynamoDB input. */
    const captureAll = (build: (db: WhereDb) => Effect.Effect<unknown, any, never>) => {
      const captured: Array<any> = []
      const ClientLayer = makeQueryCapturingClient(captured)
      const TableLayer = WhereTable.layer({ name: "where-table" })
      return Effect.gen(function* () {
        const db = yield* makeWhereDb()
        yield* build(db)
        return captured
      }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
    }

    /** Run a `.where()` query and return the (first) captured DynamoDB input. */
    const capture = (build: (db: WhereDb) => Effect.Effect<unknown, any, never>) =>
      Effect.map(captureAll(build), (captured) => captured[0])

    /** A request's sort key condition, as an operator and its operand(s). */
    const skCondition = (input: any): ReadonlyArray<string> => {
      const values = input.ExpressionAttributeValues
      const expression: string = input.KeyConditionExpression
      if (expression.includes("BETWEEN")) return ["between", values[":sk1"].S, values[":sk2"].S]
      const op = /#sk (<=|>=|=|<|>)/.exec(expression)?.[1] ?? "begins_with"
      return [op, values[":sk"].S]
    }

    const skValue = (input: any) => input.ExpressionAttributeValues[":sk"].S as string
    const skLow = (input: any) => input.ExpressionAttributeValues[":sk1"].S as string
    const skHigh = (input: any) => input.ExpressionAttributeValues[":sk2"].S as string

    // --- projections and filters send what they always sent (#133) ---------

    describe("projections and chained filters on a plain entity", () => {
      it.effect("select names its attributes as it always did", () =>
        Effect.gen(function* () {
          const byName = yield* capture((db: any) =>
            db.entities.Lookups.primary({ lookupId: "l-1" }).select(["email"]).collect(),
          )
          expect(byName.ProjectionExpression).toBe("#proj_email")
          const byPath = yield* capture((db: any) =>
            db.entities.Lookups.primary({ lookupId: "l-1" })
              .select((t: any) => [t.email])
              .collect(),
          )
          expect(byPath.ProjectionExpression).toBe("#proj0")
          expect(byPath.ExpressionAttributeNames["#proj0"]).toBe("email")
        }),
      )

      it.effect("two filters never share a placeholder", () =>
        Effect.gen(function* () {
          const input = yield* capture((db: any) =>
            db.entities.Lookups.primary({ lookupId: "l-1" })
              .filter({ email: "a@x.io" })
              .filter((t: any, { exists }: any) => exists(t.lookupId))
              .collect(),
          )
          const names = Object.entries(input.ExpressionAttributeNames)
          const placeholders = new Map<string, string>()
          for (const [placeholder, name] of names) placeholders.set(placeholder, String(name))
          expect([...placeholders.values()]).toEqual(expect.arrayContaining(["email", "lookupId"]))
          expect(input.FilterExpression).toMatch(/\(.+\) AND \(.+\)/)
        }),
      )
    })

    // --- named GSI accessor, single SK composite ---------------------------

    describe("named GSI accessor (single SK composite)", () => {
      const q = (fn: (t: any, ops: any) => any) => (db: any) =>
        db.entities.Balls.byMatch({ matchId: "m-1" }).where(fn).collect()

      it.effect("gte composes the operand into a full sort key value", () =>
        Effect.gen(function* () {
          const input = yield* capture(q((t, { gte }) => gte(t.ballKey, "1-009")))
          expect(input.IndexName).toBe("gsi1")
          expect(input.KeyConditionExpression).toContain("#sk >= :sk")
          expect(skValue(input)).toBe("$wheretest#v1#ball#ballkey_1-009")
        }),
      )

      it.effect("beginsWith composes the operand into a full sort key prefix", () =>
        Effect.gen(function* () {
          const input = yield* capture(q((t, { beginsWith }) => beginsWith(t.ballKey, "1-009")))
          expect(input.KeyConditionExpression).toContain("begins_with(#sk, :sk)")
          expect(skValue(input)).toBe("$wheretest#v1#ball#ballkey_1-009")
        }),
      )

      it.effect("between composes both bounds", () =>
        Effect.gen(function* () {
          const input = yield* capture(q((t, { between }) => between(t.ballKey, "1-009", "1-011")))
          expect(input.KeyConditionExpression).toContain("BETWEEN :sk1 AND :sk2")
          expect(skLow(input)).toBe("$wheretest#v1#ball#ballkey_1-009")
          expect(skHigh(input)).toBe("$wheretest#v1#ball#ballkey_1-011")
        }),
      )

      it.effect("eq composes an exact sort key value", () =>
        Effect.gen(function* () {
          const input = yield* capture(q((t, { eq }) => eq(t.ballKey, "1-009-1-1")))
          expect(input.KeyConditionExpression).toContain("#sk = :sk")
          expect(skValue(input)).toBe("$wheretest#v1#ball#ballkey_1-009-1-1")
        }),
      )

      it.effect("lt / lte / gt compose the operand", () =>
        Effect.gen(function* () {
          const lt = yield* capture(q((t, ops) => ops.lt(t.ballKey, "1-010")))
          expect(lt.KeyConditionExpression).toContain("#sk < :sk")
          expect(skValue(lt)).toBe("$wheretest#v1#ball#ballkey_1-010")

          const lte = yield* capture(q((t, ops) => ops.lte(t.ballKey, "1-010")))
          expect(lte.KeyConditionExpression).toContain("#sk <= :sk")
          expect(skValue(lte)).toBe("$wheretest#v1#ball#ballkey_1-010")

          const gt = yield* capture(q((t, ops) => ops.gt(t.ballKey, "1-010")))
          expect(gt.KeyConditionExpression).toContain("#sk > :sk")
          expect(skValue(gt)).toBe("$wheretest#v1#ball#ballkey_1-010")
        }),
      )

      it.effect("applies schema casing to the operand", () =>
        Effect.gen(function* () {
          const input = yield* capture(q((t, { beginsWith }) => beginsWith(t.ballKey, "1-XYZ")))
          expect(skValue(input)).toBe("$wheretest#v1#ball#ballkey_1-xyz")
        }),
      )
    })

    // --- primary-key accessor, single SK composite -------------------------

    describe("primary-key accessor (single SK composite)", () => {
      const q = (fn: (t: any, ops: any) => any) => (db: any) =>
        db.entities.Balls.primary({ matchId: "m-1" }).where(fn).collect()

      it.effect("gte / beginsWith / between compose against the base table SK", () =>
        Effect.gen(function* () {
          const gte = yield* capture(q((t, ops) => ops.gte(t.ballKey, "1-009")))
          expect(gte.IndexName).toBeUndefined()
          expect(skValue(gte)).toBe("$wheretest#v1#ball#ballkey_1-009")

          const bw = yield* capture(q((t, ops) => ops.beginsWith(t.ballKey, "1-009")))
          expect(skValue(bw)).toBe("$wheretest#v1#ball#ballkey_1-009")

          const btw = yield* capture(q((t, ops) => ops.between(t.ballKey, "1-009", "1-011")))
          expect(skLow(btw)).toBe("$wheretest#v1#ball#ballkey_1-009")
          expect(skHigh(btw)).toBe("$wheretest#v1#ball#ballkey_1-011")
        }),
      )

      it.effect("eq / lt / lte / gt compose against the base table SK", () =>
        Effect.gen(function* () {
          const eq = yield* capture(q((t, ops) => ops.eq(t.ballKey, "1-009-1-1")))
          expect(skValue(eq)).toBe("$wheretest#v1#ball#ballkey_1-009-1-1")

          const lt = yield* capture(q((t, ops) => ops.lt(t.ballKey, "1-010")))
          expect(skValue(lt)).toBe("$wheretest#v1#ball#ballkey_1-010")

          const lte = yield* capture(q((t, ops) => ops.lte(t.ballKey, "1-010")))
          expect(skValue(lte)).toBe("$wheretest#v1#ball#ballkey_1-010")

          const gt = yield* capture(q((t, ops) => ops.gt(t.ballKey, "1-010")))
          expect(skValue(gt)).toBe("$wheretest#v1#ball#ballkey_1-010")
        }),
      )
    })

    // --- multi-composite sort keys ----------------------------------------

    describe("multi-composite sort key", () => {
      const MAX = "￿"

      it.effect("targets the leading composite when none are pinned", () =>
        Effect.gen(function* () {
          const input = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1" })
              .where((t: any, ops: any) => ops.gte(t.status, "done"))
              .collect(),
          )
          expect(skValue(input)).toBe("$wheretest#v1#reading#status_done")
        }),
      )

      // With leading composites pinned by the accessor, a one-sided operator
      // must be clamped to the pinned prefix — `Query.where` REPLACES the
      // accessor's own `begins_with`, so an unclamped `>=` would leak into the
      // next composite value's keys.
      it.effect("clamps a one-sided condition to the accessor's pinned prefix", () =>
        Effect.gen(function* () {
          const pinned = "$wheretest#v1#reading#status_done"

          const gte = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1", status: "done" })
              .where((t: any, ops: any) => ops.gte(t.seq, "0042"))
              .collect(),
          )
          expect(gte.KeyConditionExpression).toContain("BETWEEN :sk1 AND :sk2")
          expect(skLow(gte)).toBe(`${pinned}#seq_0042`)
          expect(skHigh(gte)).toBe(`${pinned}#${MAX}`)

          // `seq` is the last composite: a greater value extends 0042's
          // escaped text with a character above the delimiter (`0042%20b`,
          // `0042b`), so `>` starts past `0042#`.
          const gt = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1", status: "done" })
              .where((t: any, ops: any) => ops.gt(t.seq, "0042"))
              .collect(),
          )
          expect(skLow(gt)).toBe(`${pinned}#seq_0042#${MAX}`)
          expect(skHigh(gt)).toBe(`${pinned}#${MAX}`)

          const lte = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1", status: "done" })
              .where((t: any, ops: any) => ops.lte(t.seq, "0042"))
              .collect(),
          )
          // Low bound is delimiter-terminated (#115) — the pinned composites
          // are a strict prefix, so the bound must stop on a segment boundary.
          expect(skLow(lte)).toBe(`${pinned}#`)
          expect(skHigh(lte)).toBe(`${pinned}#seq_0042`)
        }),
      )

      it.effect("lt on a pinned terminal composite ends just below the value", () =>
        Effect.gen(function* () {
          // DynamoDB has one sort key condition and BETWEEN is inclusive at
          // both ends: the high end is the greatest key text below the bound
          // (`keyJustBelow`), so the boundary item is left out by the key
          // condition itself. (Up to #171 this was refused, EDD-9046.)
          const pinned = "$wheretest#v1#reading#status_done"
          const lt = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1", status: "done" })
              .where((t: any, ops: any) => ops.lt(t.seq, "0042"))
              .collect(),
          )
          expect(skLow(lt)).toBe(`${pinned}#`)
          expect(skHigh(lt)).toBe(`${pinned}#seq_0041\u{10FFFF}`)
          expect(skHigh(lt) < `${pinned}#seq_0042`).toBe(true)
          expect(skHigh(lt) > `${pinned}#seq_0041%20z`).toBe(true)
        }),
      )

      // ---------------------------------------------------------------------
      // #121 — a condition on an already-pinned composite
      // ---------------------------------------------------------------------
      //
      // `Query.where` REPLACES the accessor's `begins_with`, so a condition on
      // a composite the accessor already pinned does not narrow within the pin
      // — it discards it. Before the fix this silently widened the query, and
      // for `eq` it returned rows with a DIFFERENT value of the pinned
      // composite. Every operator was affected, not just the one-sided ones,
      // because `pinnedKeyForm` is built from composites strictly left of the
      // target and is therefore empty at index 0.
      describe("a composite the accessor already pinned is refused (EDD-9053)", () => {
        const expectRejected = (build: (db: any) => unknown, pattern: RegExp) =>
          Effect.gen(function* () {
            const ClientLayer = makeQueryCapturingClient([])
            const TableLayer = WhereTable.layer({ name: "where-table" })
            yield* Effect.gen(function* () {
              const db = yield* DynamoClient.make({
                entities: { Balls, Readings, Lookups },
                tables: { WhereTable },
              })
              expect(() => build(db)).toThrow(pattern)
            }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
          })

        it.effect("naming the pinned composite explicitly", () =>
          expectRejected(
            (db) =>
              (db.entities.Readings.byDevice({ deviceId: "d-1", status: "done" }) as any).where(
                (t: any, ops: any) => ops.gte(t.status, "don"),
              ),
            /EDD-9053.*status.*already.*pinned/s,
          ),
        )

        // The no-cast path: one SK composite, the accessor pins it, and the
        // callback hands back a raw literal. `field` is undefined, so the
        // fallback target is the last composite — which is pinned.
        it.effect("a raw literal when the accessor pinned every composite", () =>
          expectRejected(
            (db) =>
              (db.entities.Balls.primary({ matchId: "m-1", ballKey: "1-009" }) as any).where(
                () => ({ gte: "1-0" }),
              ),
            /EDD-9053.*ballKey.*already.*pinned/s,
          ),
        )

        // Every operator, not only the one-sided ones — `eq` was the worst of
        // them, composing a key for a value the accessor had excluded.
        it.effect("every operator, not just the one-sided ones", () =>
          Effect.gen(function* () {
            const conditions = [
              { eq: "1-010" },
              { beginsWith: "1-0" },
              { between: ["1-0", "1-9"] },
              { lt: "1-9" },
              { lte: "1-9" },
              { gt: "1-0" },
              { gte: "1-0" },
            ]
            for (const condition of conditions) {
              yield* expectRejected(
                (db) =>
                  (db.entities.Balls.primary({ matchId: "m-1", ballKey: "1-009" }) as any).where(
                    () => condition,
                  ),
                /EDD-9053/,
              )
            }
          }),
        )

        // The pin must survive: an accessor with nothing pinned is unaffected,
        // and one with a leading composite pinned still clamps (not rejects) a
        // condition on the composite it left open.
        it.effect("an open composite is still accepted and clamped", () =>
          Effect.gen(function* () {
            const gte = yield* capture((db: any) =>
              db.entities.Readings.byDevice({ deviceId: "d-1", status: "done" })
                .where((t: any, ops: any) => ops.gte(t.seq, "0042"))
                .collect(),
            )
            expect(skLow(gte)).toBe("$wheretest#v1#reading#status_done#seq_0042")
            expect(skHigh(gte)).toBe(`$wheretest#v1#reading#status_done#${MAX}`)
          }),
        )
      })

      // `.where()` should not be REACHABLE in the shapes above. The runtime
      // guard covers untyped and cast call sites; these assert the type-level
      // gate that keeps well-typed code away from it. `ResolveSkFields` used to
      // resolve to `{}` rather than `never` when nothing remained, so
      // `[SkRemaining] extends [never]` never fired and `.where()` was offered
      // on every accessor — including ones with no sort key composites at all,
      // which is the only reason EDD-9045 needed to exist.
      it.effect("`.where()` is not offered once nothing remains to constrain", () =>
        Effect.gen(function* () {
          const ClientLayer = makeQueryCapturingClient([])
          const TableLayer = WhereTable.layer({ name: "where-table" })
          yield* Effect.gen(function* () {
            const db = yield* DynamoClient.make({
              entities: { Balls, Readings, Lookups },
              tables: { WhereTable },
            })

            // Type-level only — never invoked. The calls below would throw
            // EDD-9053 / EDD-9045 at runtime; what is under test is that they
            // do not COMPILE, which `tsconfig.test.json` checks (#106).
            const _neverRun = () => {
              // Every SK composite pinned by the accessor.
              // @ts-expect-error `.where()` is gone once SkRemaining is never
              db.entities.Balls.primary({ matchId: "m-1", ballKey: "1-009" }).where(() => ({
                gte: "1-0",
              }))

              // Index whose sort key has no composites at all.
              // @ts-expect-error `.where()` is gone once SkRemaining is never
              db.entities.Lookups.byEmail({ email: "a@b.c" }).where(() => ({ gte: "x" }))
            }
            void _neverRun

            // Still offered while a composite remains open.
            expect(
              typeof db.entities.Readings.byDevice({ deviceId: "d-1", status: "done" }).where,
            ).toBe("function")
          }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
        }),
      )

      it.effect("eq / beginsWith / between stay inside the pinned prefix unchanged", () =>
        Effect.gen(function* () {
          const pinned = "$wheretest#v1#reading#status_done"

          const eq = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1", status: "done" })
              .where((t: any, ops: any) => ops.eq(t.seq, "0042"))
              .collect(),
          )
          expect(eq.KeyConditionExpression).toContain("#sk = :sk")
          expect(skValue(eq)).toBe(`${pinned}#seq_0042`)

          const btw = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1", status: "done" })
              .where((t: any, ops: any) => ops.between(t.seq, "0001", "0042"))
              .collect(),
          )
          expect(skLow(btw)).toBe(`${pinned}#seq_0001`)
          expect(skHigh(btw)).toBe(`${pinned}#seq_0042`)
        }),
      )

      it.effect("eq on a non-terminal composite selects the value and its subtree", () =>
        Effect.gen(function* () {
          const input = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1" })
              .where((t: any, ops: any) => ops.eq(t.status, "done"))
              .collect(),
          )
          const done = "$wheretest#v1#reading#status_done"
          expect(skCondition(input)).toEqual(["between", done, `${done}#\uFFFF`])
        }),
      )

      it.effect("inclusive upper bounds on a non-terminal composite span its subtree", () =>
        Effect.gen(function* () {
          const done = "$wheretest#v1#reading#status_done"
          // `status` is a free-form string, whose escaped text sorts as its
          // value (#171): `done later` is `done%20later`, above `done#…`. So
          // `≤ done` ends past `done`'s subtree and `> done` starts there, one
          // condition each.
          const lte = yield* captureAll((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1" })
              .where((t: any, ops: any) => ops.lte(t.status, "done"))
              .collect(),
          )
          expect(lte.map(skCondition)).toEqual([["<=", `${done}#${MAX}`]])

          const gt = yield* captureAll((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1" })
              .where((t: any, ops: any) => ops.gt(t.status, "done"))
              .collect(),
          )
          expect(gt.map(skCondition)).toEqual([[">", `${done}#${MAX}`]])

          const btw = yield* captureAll((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1" })
              .where((t: any, ops: any) => ops.between(t.status, "a", "done"))
              .collect(),
          )
          expect(btw.map(skCondition)).toEqual([
            ["between", "$wheretest#v1#reading#status_a", `${done}#${MAX}`],
          ])

          // A value holding a character up to `%` composes escaped.
          const spaced = yield* captureAll((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1" })
              .where((t: any, ops: any) => ops.lte(t.status, "done later"))
              .collect(),
          )
          expect(spaced.map(skCondition)).toEqual([["<=", `${done}%20later#${MAX}`]])
        }),
      )

      it.effect("exclusive lower / upper bounds stay at the composite boundary", () =>
        Effect.gen(function* () {
          const gte = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1" })
              .where((t: any, ops: any) => ops.gte(t.status, "done"))
              .collect(),
          )
          expect(skValue(gte)).toBe("$wheretest#v1#reading#status_done")

          const lt = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1" })
              .where((t: any, ops: any) => ops.lt(t.status, "done"))
              .collect(),
          )
          expect(skValue(lt)).toBe("$wheretest#v1#reading#status_done")
        }),
      )
    })

    // --- error cases -------------------------------------------------------

    describe("errors", () => {
      const ClientLayer = makeQueryCapturingClient([])
      const TableLayer = WhereTable.layer({ name: "where-table" })

      it.effect("EDD-9004 when the condition skips a leading SK composite", () =>
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { Balls, Readings, Lookups },
            tables: { WhereTable },
          })
          expect(() =>
            (db.entities.Readings.byDevice({ deviceId: "d-1" }) as any).where((t: any, ops: any) =>
              ops.gte(t.seq, "0042"),
            ),
          ).toThrow(/EDD-9004.*seq.*status/s)
        }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer))),
      )

      it.effect("EDD-9045 when the index SK has no composites", () =>
        Effect.gen(function* () {
          const db = yield* DynamoClient.make({
            entities: { Balls, Readings, Lookups },
            tables: { WhereTable },
          })
          expect(() =>
            (db.entities.Lookups.byEmail({ email: "a@b.com" }) as any).where((t: any, ops: any) =>
              ops.gte(t.anything, "x"),
            ),
          ).toThrow(/EDD-9045/)
        }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer))),
      )
    })
  })

  // -------------------------------------------------------------------------
  // Sort key prefix delimiter (#115) + typed `.where()` operands (#114)
  // -------------------------------------------------------------------------

  describe("sort key prefix + operand serialization", () => {
    const AppSchema = DynamoSchema.make({ name: "skprefix", version: 1 })

    const makeQueryCapturingClient = (captured: Array<unknown>) =>
      mockDynamoClientLayer({
        query: (input) =>
          Effect.sync(() => {
            captured.push(input)
            return { Items: [], Count: 0 } as never
          }),
      })

    // Two SK composites — the partial-prefix shape from #115.
    class Task extends Schema.Class<Task>("Task")({
      tenantId: Schema.String,
      status: Schema.String,
      taskId: Schema.String,
    }) {}

    const Tasks = Entity.make({
      model: Task,
      entityType: "Task",
      primaryKey: {
        pk: { field: "pk", composite: ["tenantId"] },
        sk: { field: "sk", composite: ["status", "taskId"] },
      },
      indexes: {
        byTenant: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["tenantId"] },
          sk: { field: "gsi1sk", composite: ["status", "taskId"] },
        },
      },
    })

    // Single SK composite — supplying it is a COMPLETE key, so no delimiter.
    class Note extends Schema.Class<Note>("Note")({
      boardId: Schema.String,
      label: Schema.String,
    }) {}

    const Notes = Entity.make({
      model: Note,
      entityType: "Note",
      primaryKey: {
        pk: { field: "pk", composite: ["boardId"] },
        sk: { field: "sk", composite: ["label"] },
      },
      indexes: {
        byBoard: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["boardId"] },
          sk: { field: "gsi1sk", composite: ["label"] },
        },
      },
    })

    // Non-string SK composites — the #114 shapes.
    class Sample extends Schema.Class<Sample>("Sample")({
      deviceId: Schema.String,
      seq: Schema.Number,
      big: Schema.BigIntFromString,
      ok: Schema.Boolean,
      at: Schema.Date,
      zoned: Schema.DateTimeUtc,
    }) {}

    const Samples = Entity.make({
      model: Sample,
      entityType: "Sample",
      primaryKey: {
        pk: { field: "pk", composite: ["deviceId"] },
        sk: { field: "sk", composite: ["seq"] },
      },
      indexes: {
        byBig: {
          name: "gsi1",
          pk: { field: "gsi1pk", composite: ["deviceId"] },
          sk: { field: "gsi1sk", composite: ["big"] },
        },
        byFlag: {
          name: "gsi2",
          pk: { field: "gsi2pk", composite: ["deviceId"] },
          sk: { field: "gsi2sk", composite: ["ok"] },
        },
        byAt: {
          name: "gsi3",
          pk: { field: "gsi3pk", composite: ["deviceId"] },
          sk: { field: "gsi3sk", composite: ["at"] },
        },
        byZoned: {
          name: "gsi4",
          pk: { field: "gsi4pk", composite: ["deviceId"] },
          sk: { field: "gsi4sk", composite: ["zoned"] },
        },
      },
    })

    const SkTable = Table.make({ schema: AppSchema, entities: { Tasks, Notes, Samples } })

    const makeSkDb = () =>
      DynamoClient.make({ entities: { Tasks, Notes, Samples }, tables: { SkTable } })
    type SkDb = Effect.Success<ReturnType<typeof makeSkDb>>

    const capture = (build: (db: SkDb) => Effect.Effect<unknown, any, never>) => {
      const captured: Array<any> = []
      const ClientLayer = makeQueryCapturingClient(captured)
      const TableLayer = SkTable.layer({ name: "sk-table" })
      return Effect.gen(function* () {
        const db = yield* makeSkDb()
        yield* build(db)
        return captured[0]
      }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
    }

    const skValue = (input: any) => input.ExpressionAttributeValues[":sk"].S as string
    const skLow = (input: any) => input.ExpressionAttributeValues[":sk1"].S as string
    const skHigh = (input: any) => input.ExpressionAttributeValues[":sk2"].S as string

    // --- #115 accessor prefix delimiter --------------------------------

    describe("accessor begins_with delimiter (#115)", () => {
      it.effect("partial SK composites stop on a segment boundary", () =>
        Effect.gen(function* () {
          const done = "$skprefix#v1#task#status_done"
          // A secondary index: the row truncated at the prefix, and what's below it.
          const gsi = yield* capture((db) =>
            db.entities.Tasks.byTenant({ tenantId: "acme", status: "done" }).collect(),
          )
          expect(gsi.KeyConditionExpression).toContain("BETWEEN :sk1 AND :sk2")
          expect(gsi.ExpressionAttributeValues![":sk1"]!.S).toBe(done)
          expect(gsi.ExpressionAttributeValues![":sk2"]!.S).toBe(`${done}#\uFFFF`)

          // The primary index holds no truncated row.
          const pk = yield* capture((db) =>
            db.entities.Tasks.primary({ tenantId: "acme", status: "done" }).collect(),
          )
          expect(pk.KeyConditionExpression).toContain("begins_with(#sk, :sk)")
          expect(skValue(pk)).toBe(`${done}#`)
        }),
      )

      it.effect("a complete SK composite set gets NO delimiter", () =>
        Effect.gen(function* () {
          const input = yield* capture((db) =>
            db.entities.Tasks.byTenant({
              tenantId: "acme",
              status: "done",
              taskId: "t1",
            }).collect(),
          )
          // Appending a delimiter here would match nothing — the stored key
          // ends at taskId.
          expect(skValue(input)).toBe("$skprefix#v1#task#status_done#taskid_t1")
        }),
      )

      it.effect("single-composite sort key is a complete key, so NO delimiter", () =>
        Effect.gen(function* () {
          const input = yield* capture((db) =>
            db.entities.Notes.byBoard({ boardId: "b1", label: "ship" }).collect(),
          )
          expect(skValue(input)).toBe("$skprefix#v1#note#label_ship")
        }),
      )

      it.effect("the bounds exclude sibling values the operand is a prefix of", () =>
        Effect.gen(function* () {
          const input = yield* capture((db) =>
            db.entities.Tasks.byTenant({ tenantId: "acme", status: "done" }).collect(),
          )
          const low = input.ExpressionAttributeValues![":sk1"]!.S!
          const high = input.ExpressionAttributeValues![":sk2"]!.S!
          const selected = (key: string) => low <= key && key <= high
          // Compose the stored keys the write path would produce.
          const stored = (status: string, taskId: string) =>
            KeyComposer.composeSk(
              AppSchema,
              "Task",
              1,
              {
                pk: { field: "pk", composite: ["tenantId"] },
                sk: { field: "sk", composite: ["status", "taskId"] },
              },
              { status, taskId },
            )
          expect(selected(stored("done", "t1"))).toBe(true)
          expect(selected(stored("done_archived", "t3"))).toBe(false)
          expect(selected(stored("doneish", "t4"))).toBe(false)
        }),
      )
    })

    // --- #115 the same rule inside .where() clamping -------------------

    describe("where() clamping uses the same delimiter rule (#115)", () => {
      const MAX = "￿"

      it.effect("pinned-prefix BETWEEN bounds terminate on a segment boundary", () =>
        Effect.gen(function* () {
          const input = yield* capture((db) =>
            db.entities.Tasks.byTenant({ tenantId: "acme", status: "done" })
              .where((t, { gte }) => gte(t.taskId, "t2"))
              .collect(),
          )
          expect(skLow(input)).toBe("$skprefix#v1#task#status_done#taskid_t2")
          expect(skHigh(input)).toBe(`$skprefix#v1#task#status_done#${MAX}`)
        }),
      )

      it.effect("eq on a non-terminal composite is the value and its subtree", () =>
        Effect.gen(function* () {
          const input = yield* capture((db) =>
            db.entities.Tasks.byTenant({ tenantId: "acme" })
              .where((t, { eq }) => eq(t.status, "done"))
              .collect(),
          )
          const done = "$skprefix#v1#task#status_done"
          expect(input.KeyConditionExpression).toContain("BETWEEN :sk1 AND :sk2")
          expect(input.ExpressionAttributeValues![":sk1"]!.S).toBe(done)
          expect(input.ExpressionAttributeValues![":sk2"]!.S).toBe(`${done}#${MAX}`)
        }),
      )

      it.effect("gt on a terminal composite keeps the unconditional sentinel delimiter", () =>
        Effect.gen(function* () {
          // `compose(v)￿` alone would sort below `compose(v + "0")`, which is a
          // strictly greater value that must stay inside a `gt`. `compose(v)#￿`
          // sorts below every greater value's key, escaped or not: an escape
          // starts with `%`, above the delimiter (#171).
          const input = yield* capture((db) =>
            db.entities.Tasks.byTenant({ tenantId: "acme", status: "done" })
              .where((t, { gt }) => gt(t.taskId, "t2"))
              .collect(),
          )
          expect(skLow(input)).toBe(`$skprefix#v1#task#status_done#taskid_t2#${MAX}`)
          for (const greater of ["t20", "t2%200", "t2%21", "t2%01"]) {
            expect(skLow(input) < `$skprefix#v1#task#status_done#taskid_${greater}`).toBe(true)
          }
        }),
      )
    })

    // --- #114 operand serialization ------------------------------------

    describe("operand serialization (#114)", () => {
      it.effect("number composite is zero-padded to 16 digits like the stored key", () =>
        Effect.gen(function* () {
          const input = yield* capture((db) =>
            db.entities.Samples.primary({ deviceId: "d1" })
              .where((t, { gte }) => gte(t.seq, 42))
              .collect(),
          )
          expect(skValue(input)).toBe("$skprefix#v1#sample#seq_0000000000000042")
        }),
      )

      it.effect("a numeric-Type/string-Encoded composite is padded, not stored raw", () =>
        Effect.gen(function* () {
          // `big` is `Schema.BigIntFromString` — Type bigint, Encoded string, so
          // the rule's exception applies: compose from the numeric Type value so
          // `serializeValue` pads it. Composing the encoded "42" sorted
          // 100 < 42 < 5.
          const input = yield* capture((db) =>
            db.entities.Samples.byBig({ deviceId: "d1" })
              .where((t, { lte }) => lte(t.big, 42n))
              .collect(),
          )
          expect(skValue(input)).toBe(`$skprefix#v1#sample#big_${"42".padStart(38, "0")}`)
        }),
      )

      it.effect("mixed-width values order numerically on a transformed composite", () =>
        Effect.gen(function* () {
          const keys: Array<string> = []
          for (const v of [5n, 42n, 100n]) {
            const input = yield* capture((db) =>
              db.entities.Samples.byBig({ deviceId: "d1" })
                .where((t, { eq }) => eq(t.big, v))
                .collect(),
            )
            keys.push(skValue(input))
          }
          expect([...keys].sort()).toEqual(keys)
        }),
      )

      it.effect("an UNtransformed bigint composite keeps the 38-digit padding", () =>
        Effect.gen(function* () {
          // Plain `Schema.BigInt` has no encoding transformation, so both the
          // write path and the operand fall through to `serializeValue`, which
          // pads. (Such an entity cannot be read back from DynamoDB — the SDK
          // unmarshalls `N` to a JS number — but the key composition on both
          // sides still agrees.)
          class Counter extends Schema.Class<Counter>("Counter")({
            counterId: Schema.String,
            tick: Schema.BigInt,
          }) {}
          const Counters = Entity.make({
            model: Counter,
            entityType: "Counter",
            primaryKey: {
              pk: { field: "pk", composite: ["counterId"] },
              sk: { field: "sk", composite: ["tick"] },
            },
          })
          const CounterTable = Table.make({ schema: AppSchema, entities: { Counters } })
          const captured: Array<any> = []
          yield* Effect.gen(function* () {
            const db = yield* DynamoClient.make({
              entities: { Counters },
              tables: { CounterTable },
            })
            yield* db.entities.Counters.primary({ counterId: "c1" })
              .where((t, { gte }) => gte(t.tick, 42n))
              .collect()
          }).pipe(
            Effect.provide(
              Layer.merge(
                makeQueryCapturingClient(captured),
                CounterTable.layer({ name: "counter-table" }),
              ),
            ),
          )
          expect(skValue(captured[0])).toBe(`$skprefix#v1#counter#tick_${"42".padStart(38, "0")}`)
        }),
      )

      it.effect("refuses an operand that cannot be encoded (EDD-9050)", () =>
        Effect.gen(function* () {
          const ClientLayer = makeQueryCapturingClient([])
          const TableLayer = SkTable.layer({ name: "sk-table" })
          yield* Effect.gen(function* () {
            const db = yield* DynamoClient.make({
              entities: { Tasks, Notes, Samples },
              tables: { SkTable },
            })
            expect(() =>
              (db.entities.Samples.byBig({ deviceId: "d1" }) as any).where((t: any, ops: any) =>
                ops.eq(t.big, "not-a-number"),
              ),
            ).toThrow(/EDD-9050.*big/s)
          }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
        }),
      )

      it.effect("refuses an accessor composite that cannot be encoded (EDD-9050)", () =>
        Effect.gen(function* () {
          const ClientLayer = makeQueryCapturingClient([])
          const TableLayer = SkTable.layer({ name: "sk-table" })
          yield* Effect.gen(function* () {
            const db = yield* DynamoClient.make({
              entities: { Tasks, Notes, Samples },
              tables: { SkTable },
            })
            expect(() =>
              (db.entities.Samples.byBig as any)({ deviceId: "d1", big: "not-a-number" }),
            ).toThrow(/EDD-9050.*big/s)
          }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
        }),
      )

      it.effect("boolean composite serializes to true/false", () =>
        Effect.gen(function* () {
          const input = yield* capture((db) =>
            db.entities.Samples.byFlag({ deviceId: "d1" })
              .where((t, { eq }) => eq(t.ok, true))
              .collect(),
          )
          expect(skValue(input)).toBe("$skprefix#v1#sample#ok_true")
        }),
      )

      it.effect("Date composite serializes to its ISO form (lower-cased by key casing)", () =>
        Effect.gen(function* () {
          const input = yield* capture((db) =>
            db.entities.Samples.byAt({ deviceId: "d1" })
              .where((t, { gt }) => gt(t.at, new Date("2026-02-11T00:00:00.000Z")))
              .collect(),
          )
          expect(skValue(input)).toBe("$skprefix#v1#sample#at_2026-02-11t00:00:00.000z")
        }),
      )

      it.effect("DateTime composite serializes to its ISO form", () =>
        Effect.gen(function* () {
          const dt = DateTime.makeUnsafe("2026-02-11T00:00:00.000Z")
          const input = yield* capture((db) =>
            db.entities.Samples.byZoned({ deviceId: "d1" })
              .where((t, { gte }) => gte(t.zoned, dt))
              .collect(),
          )
          expect(skValue(input)).toBe("$skprefix#v1#sample#zoned_2026-02-11t00:00:00.000z")
        }),
      )

      it.effect("between serializes both bounds", () =>
        Effect.gen(function* () {
          const input = yield* capture((db) =>
            db.entities.Samples.primary({ deviceId: "d1" })
              .where((t, { between }) => between(t.seq, 5, 100))
              .collect(),
          )
          expect(skLow(input)).toBe("$skprefix#v1#sample#seq_0000000000000005")
          expect(skHigh(input)).toBe("$skprefix#v1#sample#seq_0000000000000100")
        }),
      )

      it.effect("string composites are unchanged — serializeValue is identity", () =>
        Effect.gen(function* () {
          const input = yield* capture((db) =>
            db.entities.Tasks.byTenant({ tenantId: "acme" })
              .where((t, { beginsWith }) => beginsWith(t.status, "do"))
              .collect(),
          )
          expect(skValue(input)).toBe("$skprefix#v1#task#status_do")
        }),
      )

      it("rejects a stringly-typed operand on a non-string composite", () => {
        // The #114 defect: `"42"` compiled and then sorted after every stored
        // (padded) value. The type now refuses it.
        const _typeGuard = (db: any) =>
          db.entities.Samples.primary({ deviceId: "d1" }).where(
            (t: { seq: number }, ops: SkConditionOps<{ seq: number }>) =>
              // @ts-expect-error — string is not assignable to a number composite
              ops.gte(t.seq, "42"),
          )
        expect(typeof _typeGuard).toBe("function")
      })

      it("still accepts an arbitrary string bound on a string composite", () => {
        // Literal-union and plain string composites widen to `string` so open
        // bounds and prefixes that are not themselves values still typecheck.
        const _typeGuard = (db: any) =>
          db.entities.Tasks.byTenant({ tenantId: "acme" }).where(
            (t: { status: string; taskId: string }, ops: SkConditionOps<{ status: string }>) =>
              ops.beginsWith(t.status, "d"),
          )
        expect(typeof _typeGuard).toBe("function")
      })
    })
  })
})

// ---------------------------------------------------------------------------
// .within() on composite accessors (#171)
// ---------------------------------------------------------------------------

describe(".within() on composite accessors (#171)", () => {
  it("composeRangeUnder matches composeSortKeyPrefix", () => {
    // `.where()` and `.within()` compose a bound through composeRangeUnder;
    // the write path composes keys through KeyComposer. Every operand must be
    // the key text `put` would write for the same composites.
    const schema = DynamoSchema.make({ name: "parity", version: 1 })
    const shapes = {
      plain: {},
      isolated: { collection: "byTenant", type: "isolated" as const },
      clustered: { collection: "byTenant", type: "clustered" as const },
    }
    const values = {
      string: "Widget A",
      number: 42,
      date: new Date("2026-10-27T10:00:00.000Z"),
    }
    for (const [shapeName, shape] of Object.entries(shapes)) {
      for (const casing of ["lowercase", "uppercase", "preserve"] as const) {
        for (const [kind, value] of Object.entries(values)) {
          const context = `${shapeName} / ${casing} / ${kind}`
          const index: KeyComposer.IndexDefinition = {
            index: "gsi1",
            pk: { field: "gsi1pk", composite: ["tenant"] },
            sk: { field: "gsi1sk", composite: ["region", "value", "id"] },
            casing,
            ...shape,
          }
          const effective = KeyComposer.effectiveCasing(schema, index)
          const pinnedKeyForm = { region: "EU-West" }
          const recordKeyForm = { ...pinnedKeyForm, value }
          const prefixText = KeyComposer.composeSortKeyBeginsWith(
            schema,
            "Thing",
            1,
            index,
            pinnedKeyForm,
          )
          const under = (bound: any, isLast = false, prefix = prefixText) =>
            composeRangeUnder(
              { casing: effective, isLast, secondary: true },
              prefix,
              isLast ? "id" : "value",
              bound,
              {
                clampToPrefix: true,
              },
            )
          const composed = KeyComposer.composeSortKeyPrefix(
            schema,
            "Thing",
            1,
            index,
            recordKeyForm,
          )
          // A lower bound starts exactly at the composed value…
          expect(under({ gte: value }), context).toEqual({
            between: [composed, `${prefixText}￿`],
          })
          // …an upper one ends at it…
          expect(under({ lt: value }), context).toEqual({ between: [prefixText, composed] })
          // …an eq bound is the value's subtree, as a pin on the record is…
          expect(under({ eq: value }), context).toEqual(
            KeyComposer.composeSortKeyCondition(schema, "Thing", 1, index, recordKeyForm),
          )
          // …and on the last composite it is the whole stored key.
          const fullKeyForm = { ...recordKeyForm, id: "X-1" }
          const lastPrefix = KeyComposer.composeSortKeyBeginsWith(
            schema,
            "Thing",
            1,
            index,
            recordKeyForm,
          )
          const fullKey = KeyComposer.composeSortKeyPrefix(schema, "Thing", 1, index, fullKeyForm)
          expect(under({ eq: "X-1" }, true, lastPrefix), context).toEqual({ eq: fullKey })
          // A strict lt on the last composite ends just below the stored key.
          expect(under({ lt: "X-1" }, true, lastPrefix), context).toEqual({
            between: [lastPrefix, keyJustBelow(fullKey)],
          })
        }
      }
    }
  })

  const AppSchema = DynamoSchema.make({ name: "withintest", version: 1 })

  class Order extends Schema.Class<Order>("Order")({
    customerId: Schema.String,
    orderId: Schema.String,
    status: Schema.Literals(["open", "paid", "shipped"]),
    total: Schema.Number,
  }) {}

  const Orders = Entity.make({
    model: Order,
    entityType: "Order",
    primaryKey: {
      pk: { field: "pk", composite: ["orderId"] },
      sk: { field: "sk", composite: [] },
    },
    indexes: {
      byCustomer: {
        name: "gsi1",
        pk: { field: "gsi1pk", composite: ["customerId"] },
        sk: { field: "gsi1sk", composite: ["status", "total", "orderId"] },
      },
      byActivity: {
        name: "gsi2",
        collection: "activity",
        type: "clustered",
        pk: { field: "gsi2pk", composite: ["customerId"] },
        sk: { field: "gsi2sk", composite: ["status", "total"] },
      },
    },
  })

  const WithinTable = Table.make({ schema: AppSchema, entities: { Orders } })
  const makeDb = () => DynamoClient.make({ entities: { Orders }, tables: { WithinTable } })
  type Db = Effect.Success<ReturnType<typeof makeDb>>

  /** The first request a query sends (served empty), or the error building it threw. */
  const capture = (build: (db: Db) => Effect.Effect<unknown, any, never>) => {
    const captured: Array<any> = []
    const ClientLayer = mockDynamoClientLayer({
      query: (input) =>
        Effect.sync(() => {
          captured.push(input)
          return { Items: [], Count: 0 } as never
        }),
    })
    return Effect.gen(function* () {
      const db = yield* makeDb()
      yield* build(db)
      return captured[0]
    }).pipe(Effect.provide(Layer.merge(ClientLayer, WithinTable.layer({ name: "within" }))))
  }

  it.effect("a bound behind an unbounded composite probes first", () =>
    Effect.gen(function* () {
      const input = yield* capture((db) =>
        db.entities.Orders.byCustomer({ customerId: "c-1" })
          .within({ total: { gte: 100 } })
          .collect(),
      )
      const P = "$withintest#v1#order#"
      expect(input.Limit).toBe(1)
      expect(input.ProjectionExpression).toBe("#sk")
      expect(input.FilterExpression).toBeUndefined()
      expect(input.ExpressionAttributeNames["#sk"]).toBe("gsi1sk")
      expect(input.ExpressionAttributeValues[":sk1"]).toEqual({ S: P })
      expect(input.ExpressionAttributeValues[":sk2"]).toEqual({ S: `${P}￿` })
    }),
  )

  it.effect("an eq bound then a range is the key plan, composed as .where() composes it", () =>
    Effect.gen(function* () {
      const bounds = [
        [{ gte: 100 }, (t: any, { gte }: any) => gte(t.total, 100)],
        [{ gt: 100 }, (t: any, { gt }: any) => gt(t.total, 100)],
        [{ lte: 100 }, (t: any, { lte }: any) => lte(t.total, 100)],
        [{ between: [10, 100] }, (t: any, { between }: any) => between(t.total, 10, 100)],
        [{ eq: 100 }, (t: any, { eq }: any) => eq(t.total, 100)],
      ] as const
      for (const [bound, where] of bounds) {
        const within = yield* capture((db) =>
          db.entities.Orders.byCustomer({ customerId: "c-1" })
            .within({ status: { eq: "open" }, total: bound as any })
            .collect(),
        )
        const pinned = yield* capture((db) =>
          (db.entities.Orders.byCustomer({ customerId: "c-1", status: "open" }) as any)
            .where(where)
            .collect(),
        )
        expect(within, JSON.stringify(bound)).toEqual(pinned)
      }
    }),
  )

  it.effect("{} plans nothing", () =>
    Effect.gen(function* () {
      const within = yield* capture((db) =>
        db.entities.Orders.byCustomer({ customerId: "c-1" }).within({}).collect(),
      )
      const plain = yield* capture((db) =>
        db.entities.Orders.byCustomer({ customerId: "c-1" }).collect(),
      )
      expect(within).toEqual(plain)
    }),
  )

  it.effect("a clustered collection member index skip-scans under its member prefix", () =>
    Effect.gen(function* () {
      const db = yield* makeDb()
      const query = db.entities.Orders.byActivity({ customerId: "c-1" }).within({
        total: { lt: 50 },
      })
      const explain = yield* query.explain()
      expect(explain.plan).toBe("skip-scan")
      expect(explain.reason).toBe("skip tuple: status")
      // `total` is the last composite: the strict bound ends just below the
      // value's key, so nothing is checked per row.
      expect(explain.rowChecks).toEqual([])
      const P = explain.keyConditions[0]!.lower!
      expect(P.endsWith("#")).toBe(true)
      expect(P).toContain("order")
    }).pipe(Effect.provide(Layer.merge(TestDynamoClient, WithinTable.layer({ name: "within" })))),
  )

  it.effect("misuse from untyped code throws EDD-9093", () =>
    Effect.gen(function* () {
      const db = yield* makeDb()
      const byCustomer = (pins: object) => (db.entities.Orders.byCustomer as any)(pins)
      const cases: Array<readonly [object, unknown, RegExp]> = [
        [{ customerId: "c-1" }, { customerId: { eq: "c-2" } }, /partition key composite/],
        [{ customerId: "c-1" }, { colour: { eq: "red" } }, /not a sort key composite/],
        [{ customerId: "c-1", status: "open" }, { status: { eq: "paid" } }, /already pinned/],
        [{ customerId: "c-1" }, { total: { lt: 1, lte: 2 } }, /is not one of/],
        [{ customerId: "c-1" }, { total: { eq: 1, gte: 2 } }, /is not one of/],
        [{ customerId: "c-1" }, { total: { between: [1] } }, /is not one of/],
        [{ customerId: "c-1" }, { total: {} }, /is not one of/],
        [{ customerId: "c-1" }, { total: { gte: "100" } }, /key form is a number/],
        [{ customerId: "c-1" }, [{ total: { gte: 1 } }], /pass an object of bounds/],
      ]
      for (const [pins, bounds, message] of cases) {
        expect(() => byCustomer(pins).within(bounds), JSON.stringify(bounds)).toThrow(/EDD-9093/)
        expect(() => byCustomer(pins).within(bounds), JSON.stringify(bounds)).toThrow(message)
      }
    }).pipe(Effect.provide(Layer.merge(TestDynamoClient, WithinTable.layer({ name: "within" })))),
  )
})

// ---------------------------------------------------------------------------
// .within() on Z-order accessors (#171)
// ---------------------------------------------------------------------------

describe(".within() on Z-order accessors (#171)", () => {
  const rows = ZListings.storedRows(ZListings.randomZListings(3, 40))
  const run = <X, E>(
    body: (listings: Effect.Success<typeof ZListings.listings>) => Effect.Effect<X, E>,
  ) => {
    const { layer } = ZListings.servePartition("byFacets", rows)
    return Effect.flatMap(ZListings.listings, body).pipe(Effect.provide(layer))
  }

  it.effect("plans the box at .within(): explain and a terminal see one plan", () =>
    run((listings) =>
      Effect.gen(function* () {
        const query = listings
          .byFacets({ region: ZListings.REGION })
          .within({ price: { lte: 300 }, bedrooms: { gte: 2 } })
        const explain = yield* query.explain()
        expect(explain.index).toBe("gsi1")
        expect(explain.zorder?.box.map((dim) => [dim.field, dim.levels])).toEqual([
          ["price", [["0", "300"]]],
          ["bedrooms", [["2", "15"]]],
        ])
        const zorder = yield* query.zorder({ strategy: "naive" }).explain()
        expect([zorder.plan, zorder.keyConditions.length]).toEqual(["naive", 1])
      }),
    ),
  )

  it.effect("misuse from untyped code throws EDD-9093 at .within()", () =>
    run((listings) =>
      Effect.gen(function* () {
        const byAgency = (bounds: unknown) =>
          (listings.byAgency({ region: ZListings.REGION }) as any).within(bounds)
        const cases: Array<readonly [unknown, RegExp]> = [
          [[{ price: { gte: 1 } }], /pass an object of bounds/],
          [{ region: { eq: "south" } }, /partition key composite/],
          [{ colour: { eq: "red" } }, /not a dimension or prefix composite/],
          [{ agencyId: { gte: "ag-1" } }, /takes one exact value, not a range bound/],
          [{ price: { lt: 1, lte: 2 } }, /is not one of/],
          [{ price: { eq: 1, gte: 0 } }, /is not one of/],
          [{ price: {} }, /is not one of/],
          [{ price: { between: [1] } }, /is not one of/],
          [{ price: { in: [1, 2] } }, /"in" bounds only a literals dimension/],
          [{ price: { gte: "100" } }, /key form is a number/],
        ]
        for (const [bounds, message] of cases) {
          expect(() => byAgency(bounds), JSON.stringify(bounds)).toThrow(/\[EDD-9093\]/)
          expect(() => byAgency(bounds), JSON.stringify(bounds)).toThrow(message)
        }
      }),
    ),
  )

  it.effect("a value no level holds throws EDD-9092 at .within()", () =>
    run((listings) =>
      Effect.gen(function* () {
        const byStatus = listings.byStatus({ region: ZListings.REGION }) as any
        expect(() => byStatus.within({ status: { eq: "archived" } })).toThrow(
          /\[EDD-9092\] Z-order dimension "status" can't place "archived"/,
        )
        expect(() => byStatus.within({ status: { in: ["live", "archived"] } })).toThrow(
          /\[EDD-9092\]/,
        )
        const byFacets = listings.byFacets({ region: ZListings.REGION }) as any
        expect(() => byFacets.within({ price: { gte: Number.NaN } })).toThrow(
          /\[EDD-9092\] Z-order dimension "price" can't place NaN/,
        )
        // Out of range is clamped into the box, never refused: the filter is exact.
        expect(() => byFacets.within({ price: { gte: 5_000 } })).not.toThrow()
      }),
    ),
  )
})
