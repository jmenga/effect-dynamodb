import { describe, expect, it } from "@effect/vitest"
import { Config, ConfigProvider, Effect, Layer } from "effect"
import { beforeEach, vi } from "vitest"

const configFromMap = (entries: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(entries))

import { DynamoClient } from "../src/DynamoClient.js"
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
} from "../src/Errors.js"

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
})
