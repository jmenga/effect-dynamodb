import { describe, expect, it } from "@effect/vitest"
import { Config, ConfigProvider, Effect, Layer, Schema } from "effect"
import { beforeEach, vi } from "vitest"

const configFromMap = (entries: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(entries))

import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import {
  DynamoError,
  DynamoValidationError,
  InternalServerError,
  isAwsInternalServerError,
  isAwsResourceNotFound,
  isAwsThrottling,
  isAwsValidationError,
  ResourceNotFoundError,
  ThrottlingError,
} from "@effect-dynamodb/schema/Errors.js"
import * as Aggregate from "../src/Aggregate.js"
import { DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"

// Create a mock DynamoClient layer for testing
const mockPutItem = vi.fn()
const mockGetItem = vi.fn()
const mockDeleteItem = vi.fn()
const mockUpdateItem = vi.fn()
const mockQuery = vi.fn()

const TestDynamoClient = Layer.succeed(DynamoClient, {
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
  batchGetItem: () => Effect.die("not used"),
  batchWriteItem: () => Effect.die("not used"),
  transactGetItems: () => Effect.die("not used"),
  transactWriteItems: () => Effect.die("not used"),
  createTable: () => Effect.die("not used"),
  deleteTable: () => Effect.die("not used"),
  describeTable: () => Effect.die("not used"),
  scan: () => Effect.die("not used"),
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
            region: Config.string("AWS_REGION"),
            endpoint: Config.string("DYNAMODB_ENDPOINT"),
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
        Effect.provide(DynamoClient.layerConfig({ region: Config.string("MISSING_REGION") })),
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
        Effect.provide(DynamoClient.layerConfig({ region: Config.string("AWS_REGION") })),
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
    const classifyError =
      (operation: string) =>
      (
        cause: unknown,
      ):
        | DynamoError
        | ThrottlingError
        | DynamoValidationError
        | InternalServerError
        | ResourceNotFoundError => {
        if (isAwsThrottling(cause)) return new ThrottlingError({ operation, cause })
        if (isAwsValidationError(cause)) return new DynamoValidationError({ operation, cause })
        if (isAwsInternalServerError(cause)) return new InternalServerError({ operation, cause })
        if (isAwsResourceNotFound(cause)) return new ResourceNotFoundError({ operation, cause })
        return new DynamoError({ operation, cause })
      }

    const mockClassifiedPutItem = vi.fn()

    const ClassifiedDynamoClient = Layer.succeed(DynamoClient, {
      putItem: (input) =>
        Effect.tryPromise({
          try: () => mockClassifiedPutItem(input),
          catch: classifyError("PutItem"),
        }),
      getItem: () => Effect.die("not used"),
      deleteItem: () => Effect.die("not used"),
      updateItem: () => Effect.die("not used"),
      query: () => Effect.die("not used"),
      batchGetItem: () => Effect.die("not used"),
      batchWriteItem: () => Effect.die("not used"),
      transactGetItems: () => Effect.die("not used"),
      transactWriteItems: () => Effect.die("not used"),
      createTable: () => Effect.die("not used"),
      deleteTable: () => Effect.die("not used"),
      describeTable: () => Effect.die("not used"),
      scan: () => Effect.die("not used"),
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
      Layer.succeed(DynamoClient, {
        putItem: () => Effect.die("not used"),
        getItem: () => Effect.die("not used"),
        deleteItem: () => Effect.die("not used"),
        updateItem: () => Effect.die("not used"),
        query: () => Effect.die("not used"),
        batchGetItem: () => Effect.die("not used"),
        batchWriteItem: () => Effect.die("not used"),
        transactGetItems: () => Effect.die("not used"),
        transactWriteItems: () => Effect.die("not used"),
        createTable: (input) =>
          Effect.sync(() => {
            captured.push(input)
            return {} as never
          }),
        deleteTable: () => Effect.die("not used"),
        describeTable: () => Effect.die("not used"),
        scan: () => Effect.die("not used"),
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
      Layer.succeed(DynamoClient, {
        putItem: () => Effect.die("not used"),
        getItem: () => Effect.die("not used"),
        deleteItem: () => Effect.die("not used"),
        updateItem: () => Effect.die("not used"),
        query: (input) =>
          Effect.sync(() => {
            captured.push(input)
            return { Items: [], Count: 0 } as never
          }),
        batchGetItem: () => Effect.die("not used"),
        batchWriteItem: () => Effect.die("not used"),
        transactGetItems: () => Effect.die("not used"),
        transactWriteItems: () => Effect.die("not used"),
        createTable: () => Effect.die("not used"),
        deleteTable: () => Effect.die("not used"),
        describeTable: () => Effect.die("not used"),
        scan: () => Effect.die("not used"),
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

    it.effect("PK + partial SK applies begins_with on the composed SK prefix", () => {
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
        // begins_with is used even when the full SK composite is provided — the
        // accessor treats any SK composite value as a prefix, consistent with
        // how GSI accessors handle partial SK composites.
        expect(input.KeyConditionExpression).toContain("begins_with")
        const skValue = input.ExpressionAttributeValues[":sk"].S as string
        expect(skValue).toContain("ch-42")
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

        // .filter() and .limit() must chain without type errors and propagate
        // to the underlying DynamoDB query input.
        yield* db.entities.AccountChannel.primary({ accountId: "acct-1" })
          .filter({ grantedBy: "admin" })
          .limit(5)
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
      Layer.succeed(DynamoClient, {
        putItem: () => Effect.die("not used"),
        getItem: () => Effect.die("not used"),
        deleteItem: () => Effect.die("not used"),
        updateItem: () => Effect.die("not used"),
        query: (input) =>
          Effect.sync(() => {
            captured.push(input)
            return { Items: [], Count: 0 } as never
          }),
        batchGetItem: () => Effect.die("not used"),
        batchWriteItem: () => Effect.die("not used"),
        transactGetItems: () => Effect.die("not used"),
        transactWriteItems: () => Effect.die("not used"),
        createTable: () => Effect.die("not used"),
        deleteTable: () => Effect.die("not used"),
        describeTable: () => Effect.die("not used"),
        scan: () => Effect.die("not used"),
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

    /** Run a `.where()` query and return the captured DynamoDB input. */
    const capture = (
      build: (db: {
        readonly entities: {
          readonly Balls: any
          readonly Readings: any
          readonly Lookups: any
        }
      }) => Effect.Effect<unknown, any, never>,
    ) => {
      const captured: Array<any> = []
      const ClientLayer = makeQueryCapturingClient(captured)
      const TableLayer = WhereTable.layer({ name: "where-table" })
      return Effect.gen(function* () {
        const db = yield* DynamoClient.make({
          entities: { Balls, Readings, Lookups },
          tables: { WhereTable },
        })
        yield* build(db as never)
        return captured[0]
      }).pipe(Effect.provide(Layer.merge(ClientLayer, TableLayer)))
    }

    const skValue = (input: any) => input.ExpressionAttributeValues[":sk"].S as string
    const skLow = (input: any) => input.ExpressionAttributeValues[":sk1"].S as string
    const skHigh = (input: any) => input.ExpressionAttributeValues[":sk2"].S as string

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
          expect(skLow(lte)).toBe(pinned)
          expect(skHigh(lte)).toBe(`${pinned}#seq_0042`)
        }),
      )

      it.effect("lt on a pinned terminal composite is refused (EDD-9046)", () =>
        Effect.gen(function* () {
          // DynamoDB has one sort key condition, BETWEEN is inclusive at both
          // ends, and a FilterExpression may not reference a key attribute — so
          // `begins_with(prefix) AND sk < value` is inexpressible. Refuse rather
          // than silently return the boundary item.
          const ClientLayer = makeQueryCapturingClient([])
          const TableLayer = WhereTable.layer({ name: "where-table" })
          yield* Effect.gen(function* () {
            const db = yield* DynamoClient.make({
              entities: { Balls, Readings, Lookups },
              tables: { WhereTable },
            })
            expect(() =>
              (db.entities.Readings.byDevice({ deviceId: "d-1", status: "done" }) as any).where(
                (t: any, ops: any) => ops.lt(t.seq, "0042"),
              ),
            ).toThrow(/EDD-9046.*seq.*status/s)
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

      it.effect("eq on a non-terminal composite becomes a subtree begins_with", () =>
        Effect.gen(function* () {
          const input = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1" })
              .where((t: any, ops: any) => ops.eq(t.status, "done"))
              .collect(),
          )
          expect(input.KeyConditionExpression).toContain("begins_with(#sk, :sk)")
          expect(skValue(input)).toBe("$wheretest#v1#reading#status_done#")
        }),
      )

      it.effect("inclusive upper bounds on a non-terminal composite span its subtree", () =>
        Effect.gen(function* () {
          const lte = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1" })
              .where((t: any, ops: any) => ops.lte(t.status, "done"))
              .collect(),
          )
          expect(skValue(lte)).toBe(`$wheretest#v1#reading#status_done#${MAX}`)

          const gt = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1" })
              .where((t: any, ops: any) => ops.gt(t.status, "done"))
              .collect(),
          )
          expect(skValue(gt)).toBe(`$wheretest#v1#reading#status_done#${MAX}`)

          const btw = yield* capture((db: any) =>
            db.entities.Readings.byDevice({ deviceId: "d-1" })
              .where((t: any, ops: any) => ops.between(t.status, "a", "done"))
              .collect(),
          )
          expect(skLow(btw)).toBe("$wheretest#v1#reading#status_a")
          expect(skHigh(btw)).toBe(`$wheretest#v1#reading#status_done#${MAX}`)
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
})
