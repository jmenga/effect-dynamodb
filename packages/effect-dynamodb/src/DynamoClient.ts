/**
 * DynamoClient — Effect service wrapping the AWS SDK DynamoDBClient.
 *
 * All DynamoDB operations are exposed as Effect-returning methods that fail
 * with {@link DynamoError}. The underlying SDK client lifecycle is managed
 * via `Layer.scoped` (acquire on layer build, destroy on scope close).
 *
 * @module
 */

import type {
  BatchGetItemCommandInput,
  BatchGetItemCommandOutput,
  BatchWriteItemCommandInput,
  BatchWriteItemCommandOutput,
  CreateTableCommandInput,
  CreateTableCommandOutput,
  DeleteItemCommandInput,
  DeleteItemCommandOutput,
  DeleteTableCommandInput,
  DeleteTableCommandOutput,
  GetItemCommandInput,
  GetItemCommandOutput,
  PutItemCommandInput,
  PutItemCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
  ScanCommandInput,
  ScanCommandOutput,
  TransactGetItemsCommandInput,
  TransactGetItemsCommandOutput,
  TransactWriteItemsCommandInput,
  TransactWriteItemsCommandOutput,
  UpdateItemCommandInput,
  UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb"
import {
  BatchGetItemCommand,
  BatchWriteItemCommand,
  CreateTableCommand,
  DeleteItemCommand,
  DeleteTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  TransactGetItemsCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb"
import { Config, Effect, Layer, ServiceMap } from "effect"
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
} from "./Errors.js"

/** Union of all DynamoDB client error types */
export type DynamoClientError =
  | DynamoError
  | ThrottlingError
  | DynamoValidationError
  | InternalServerError
  | ResourceNotFoundError

/**
 * Service interface for DynamoDB operations. Each method wraps a single
 * AWS SDK command and returns `Effect<Output, DynamoError>`.
 */
export interface DynamoClientService {
  /** Create a DynamoDB table. */
  readonly createTable: (
    input: CreateTableCommandInput,
  ) => Effect.Effect<CreateTableCommandOutput, DynamoClientError>

  /** Delete a DynamoDB table. */
  readonly deleteTable: (
    input: DeleteTableCommandInput,
  ) => Effect.Effect<DeleteTableCommandOutput, DynamoClientError>

  /** Put a single item. */
  readonly putItem: (
    input: PutItemCommandInput,
  ) => Effect.Effect<PutItemCommandOutput, DynamoClientError>

  /** Get a single item by key. */
  readonly getItem: (
    input: GetItemCommandInput,
  ) => Effect.Effect<GetItemCommandOutput, DynamoClientError>

  /** Delete a single item by key. */
  readonly deleteItem: (
    input: DeleteItemCommandInput,
  ) => Effect.Effect<DeleteItemCommandOutput, DynamoClientError>

  /** Update a single item with an update expression. */
  readonly updateItem: (
    input: UpdateItemCommandInput,
  ) => Effect.Effect<UpdateItemCommandOutput, DynamoClientError>

  /** Execute a query against a table or index. */
  readonly query: (input: QueryCommandInput) => Effect.Effect<QueryCommandOutput, DynamoClientError>

  /** Execute a scan against a table or index. */
  readonly scan: (input: ScanCommandInput) => Effect.Effect<ScanCommandOutput, DynamoClientError>

  /** Batch-get up to 100 items in a single request. */
  readonly batchGetItem: (
    input: BatchGetItemCommandInput,
  ) => Effect.Effect<BatchGetItemCommandOutput, DynamoClientError>

  /** Batch-write up to 25 items (puts and deletes) in a single request. */
  readonly batchWriteItem: (
    input: BatchWriteItemCommandInput,
  ) => Effect.Effect<BatchWriteItemCommandOutput, DynamoClientError>

  /** Atomically get up to 100 items across tables. */
  readonly transactGetItems: (
    input: TransactGetItemsCommandInput,
  ) => Effect.Effect<TransactGetItemsCommandOutput, DynamoClientError>

  /** Atomically write up to 100 items across tables (2x WCU cost). */
  readonly transactWriteItems: (
    input: TransactWriteItemsCommandInput,
  ) => Effect.Effect<TransactWriteItemsCommandOutput, DynamoClientError>
}

/**
 * Effect ServiceMap.Service for the DynamoDB client service.
 *
 * Use `DynamoClient.layer(config)` to construct a live Layer that manages
 * the underlying AWS SDK client lifecycle with `Effect.acquireRelease`.
 *
 * @example
 * ```typescript
 * const live = DynamoClient.layer({ region: "us-east-1" })
 * pipe(program, Effect.provide(live), Effect.runPromise)
 * ```
 */
export class DynamoClient extends ServiceMap.Service<DynamoClient, DynamoClientService>()(
  "@effect-dynamodb/DynamoClient",
) {
  /**
   * Create a live Layer that manages an AWS DynamoDBClient.
   *
   * @param config.region - AWS region
   * @param config.endpoint - Optional endpoint override (e.g., for DynamoDB Local)
   * @param config.credentials - Optional static credentials
   */
  /**
   * Create a live Layer that manages an AWS DynamoDBClient.
   *
   * @param config.region - AWS region
   * @param config.endpoint - Optional endpoint override (e.g., for DynamoDB Local)
   * @param config.credentials - Optional static credentials
   */
  static readonly layer = (config: {
    readonly region: string
    readonly endpoint?: string | undefined
    readonly credentials?:
      | { readonly accessKeyId: string; readonly secretAccessKey: string }
      | undefined
  }): Layer.Layer<DynamoClient> =>
    Layer.effect(DynamoClient, buildService(config.region, config.endpoint, config.credentials))

  /**
   * Create a live Layer that reads configuration from Effect Config providers
   * (e.g., environment variables, config files).
   *
   * @param config.region - Config for AWS region
   * @param config.endpoint - Optional Config for endpoint override
   * @param config.credentials - Optional Config for static credentials
   */
  static readonly layerConfig = (config: {
    readonly region: Config.Config<string>
    readonly endpoint?: Config.Config<string> | undefined
    readonly credentials?:
      | Config.Config<{ readonly accessKeyId: string; readonly secretAccessKey: string }>
      | undefined
  }): Layer.Layer<DynamoClient, Config.ConfigError> =>
    Layer.effect(
      DynamoClient,
      Effect.gen(function* () {
        const region = yield* config.region
        const endpoint = config.endpoint ? yield* Config.option(config.endpoint) : undefined
        const credentials = config.credentials
          ? yield* Config.option(config.credentials)
          : undefined
        return yield* buildService(
          region,
          endpoint && endpoint._tag === "Some" ? endpoint.value : undefined,
          credentials && credentials._tag === "Some" ? credentials.value : undefined,
        )
      }),
    )
}

/** @internal Classify an AWS SDK error into a specific tagged error type. */
const classifyError =
  (operation: string) =>
  (cause: unknown): DynamoClientError => {
    if (isAwsThrottling(cause)) return new ThrottlingError({ operation, cause })
    if (isAwsValidationError(cause)) return new DynamoValidationError({ operation, cause })
    if (isAwsInternalServerError(cause)) return new InternalServerError({ operation, cause })
    if (isAwsResourceNotFound(cause)) return new ResourceNotFoundError({ operation, cause })
    return new DynamoError({ operation, cause })
  }

/** @internal Build the DynamoClient service implementation from resolved config values. */
const buildService = (
  region: string,
  endpoint: string | undefined,
  credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } | undefined,
) =>
  Effect.gen(function* () {
    const clientConfig: ConstructorParameters<typeof DynamoDBClient>[0] = { region }
    if (endpoint !== undefined) clientConfig.endpoint = endpoint
    if (credentials !== undefined) clientConfig.credentials = credentials
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new DynamoDBClient(clientConfig)),
      (c) => Effect.sync(() => c.destroy()),
    )
    return {
      createTable: (input) =>
        Effect.tryPromise({
          try: () => client.send(new CreateTableCommand(input)),
          catch: classifyError("CreateTable"),
        }),
      deleteTable: (input) =>
        Effect.tryPromise({
          try: () => client.send(new DeleteTableCommand(input)),
          catch: classifyError("DeleteTable"),
        }),
      putItem: (input) =>
        Effect.tryPromise({
          try: () => client.send(new PutItemCommand(input)),
          catch: classifyError("PutItem"),
        }),
      getItem: (input) =>
        Effect.tryPromise({
          try: () => client.send(new GetItemCommand(input)),
          catch: classifyError("GetItem"),
        }),
      deleteItem: (input) =>
        Effect.tryPromise({
          try: () => client.send(new DeleteItemCommand(input)),
          catch: classifyError("DeleteItem"),
        }),
      updateItem: (input) =>
        Effect.tryPromise({
          try: () => client.send(new UpdateItemCommand(input)),
          catch: classifyError("UpdateItem"),
        }),
      query: (input) =>
        Effect.tryPromise({
          try: () => client.send(new QueryCommand(input)),
          catch: classifyError("Query"),
        }),
      scan: (input) =>
        Effect.tryPromise({
          try: () => client.send(new ScanCommand(input)),
          catch: classifyError("Scan"),
        }),
      batchGetItem: (input) =>
        Effect.tryPromise({
          try: () => client.send(new BatchGetItemCommand(input)),
          catch: classifyError("BatchGetItem"),
        }),
      batchWriteItem: (input) =>
        Effect.tryPromise({
          try: () => client.send(new BatchWriteItemCommand(input)),
          catch: classifyError("BatchWriteItem"),
        }),
      transactGetItems: (input) =>
        Effect.tryPromise({
          try: () => client.send(new TransactGetItemsCommand(input)),
          catch: classifyError("TransactGetItems"),
        }),
      transactWriteItems: (input) =>
        Effect.tryPromise({
          try: () => client.send(new TransactWriteItemsCommand(input)),
          catch: classifyError("TransactWriteItems"),
        }),
    } satisfies DynamoClientService
  })
