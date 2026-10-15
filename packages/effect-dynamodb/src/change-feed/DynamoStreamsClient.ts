/**
 * DynamoStreamsClient — Effect service wrapping the AWS SDK
 * `DynamoDBStreamsClient` (`@aws-sdk/client-dynamodb-streams`, an optional
 * peer dependency of `effect-dynamodb`).
 *
 * @module
 */

import {
  DescribeStreamCommand,
  type DescribeStreamCommandInput,
  type DescribeStreamCommandOutput,
  DynamoDBStreamsClient,
  GetRecordsCommand,
  type GetRecordsCommandInput,
  type GetRecordsCommandOutput,
  GetShardIteratorCommand,
  type GetShardIteratorCommandInput,
  type GetShardIteratorCommandOutput,
  ListStreamsCommand,
  type ListStreamsCommandInput,
  type ListStreamsCommandOutput,
} from "@aws-sdk/client-dynamodb-streams"
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
import { Config, Context, Effect, Layer } from "effect"
import { ShardIteratorExpired, StreamDataTrimmed } from "./Errors.js"

/** What a {@link DynamoStreamsClient} operation fails with. */
export type DynamoStreamsClientError =
  | DynamoError
  | ThrottlingError
  | DynamoValidationError
  | InternalServerError
  | ResourceNotFoundError
  | ShardIteratorExpired
  | StreamDataTrimmed

/**
 * The DynamoDB Streams operations, each wrapping one SDK command as an
 * `Effect`.
 */
export interface DynamoStreamsClientService {
  readonly describeStream: (
    input: DescribeStreamCommandInput,
  ) => Effect.Effect<DescribeStreamCommandOutput, DynamoStreamsClientError>
  readonly getShardIterator: (
    input: GetShardIteratorCommandInput,
  ) => Effect.Effect<GetShardIteratorCommandOutput, DynamoStreamsClientError>
  readonly getRecords: (
    input: GetRecordsCommandInput,
  ) => Effect.Effect<GetRecordsCommandOutput, DynamoStreamsClientError>
  readonly listStreams: (
    input: ListStreamsCommandInput,
  ) => Effect.Effect<ListStreamsCommandOutput, DynamoStreamsClientError>
}

const errorName = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "name" in cause
    ? String((cause as { readonly name: unknown }).name)
    : undefined

/**
 * Map an SDK failure to its tagged error. `LimitExceededException` (the
 * Streams API's throttling) is a `ThrottlingError`, like DynamoDB's own.
 */
export const classifyStreamsError =
  (operation: string) =>
  (cause: unknown): DynamoStreamsClientError => {
    const name = errorName(cause)
    if (name === "ExpiredIteratorException") return new ShardIteratorExpired({ operation, cause })
    if (name === "TrimmedDataAccessException") return new StreamDataTrimmed({ operation, cause })
    if (name === "LimitExceededException" || isAwsThrottling(cause)) {
      return new ThrottlingError({ operation, cause })
    }
    if (isAwsValidationError(cause)) return new DynamoValidationError({ operation, cause })
    if (isAwsInternalServerError(cause)) return new InternalServerError({ operation, cause })
    if (isAwsResourceNotFound(cause)) return new ResourceNotFoundError({ operation, cause })
    return new DynamoError({ operation, cause })
  }

type Credentials = { readonly accessKeyId: string; readonly secretAccessKey: string }

/** Static client configuration accepted by {@link DynamoStreamsClient.layer}. */
export interface DynamoStreamsClientConfig {
  readonly region: string
  /** Endpoint override — DynamoDB Local serves the Streams API on its own endpoint. */
  readonly endpoint?: string | undefined
  readonly credentials?: Credentials | undefined
}

/** Config-provider configuration accepted by {@link DynamoStreamsClient.layerConfig}. */
export interface DynamoStreamsClientConfigFromConfig {
  readonly region: Config.Config<string>
  readonly endpoint?: Config.Config<string> | undefined
  readonly credentials?: Config.Config<Credentials> | undefined
}

/** Wrap an SDK client as the service. */
export const fromSdkClient = (client: DynamoDBStreamsClient): DynamoStreamsClientService => ({
  describeStream: (input) =>
    Effect.tryPromise({
      try: () => client.send(new DescribeStreamCommand(input)),
      catch: classifyStreamsError("DescribeStream"),
    }),
  getShardIterator: (input) =>
    Effect.tryPromise({
      try: () => client.send(new GetShardIteratorCommand(input)),
      catch: classifyStreamsError("GetShardIterator"),
    }),
  getRecords: (input) =>
    Effect.tryPromise({
      try: () => client.send(new GetRecordsCommand(input)),
      catch: classifyStreamsError("GetRecords"),
    }),
  listStreams: (input) =>
    Effect.tryPromise({
      try: () => client.send(new ListStreamsCommand(input)),
      catch: classifyStreamsError("ListStreams"),
    }),
})

const buildService = (
  region: string,
  endpoint: string | undefined,
  credentials: Credentials | undefined,
) =>
  Effect.gen(function* () {
    const clientConfig: ConstructorParameters<typeof DynamoDBStreamsClient>[0] = { region }
    if (endpoint !== undefined) clientConfig.endpoint = endpoint
    if (credentials !== undefined) clientConfig.credentials = credentials
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new DynamoDBStreamsClient(clientConfig)),
      (c) => Effect.sync(() => c.destroy()),
    )
    return fromSdkClient(client)
  })

/**
 * Effect `Context.Service` for the DynamoDB Streams client.
 *
 * @example
 * ```typescript
 * import { DynamoStreamsClient } from "effect-dynamodb/change-feed"
 *
 * const StreamsLive = DynamoStreamsClient.layer({ region: "us-east-1" })
 * ```
 */
export class DynamoStreamsClient extends Context.Service<
  DynamoStreamsClient,
  DynamoStreamsClientService
>()("@effect-dynamodb/DynamoStreamsClient") {
  /**
   * A live layer managing a `DynamoDBStreamsClient` — created when the layer
   * is built, destroyed when its scope closes.
   */
  static readonly layer = (config: DynamoStreamsClientConfig): Layer.Layer<DynamoStreamsClient> =>
    Layer.effect(
      DynamoStreamsClient,
      buildService(config.region, config.endpoint, config.credentials),
    )

  /** A layer over an SDK client you construct and own (custom configuration). */
  static readonly layerFromSdkClient = (
    client: DynamoDBStreamsClient,
  ): Layer.Layer<DynamoStreamsClient> => Layer.succeed(DynamoStreamsClient, fromSdkClient(client))

  /** A live layer reading its configuration from Effect `Config` providers. */
  static readonly layerConfig = (
    config: DynamoStreamsClientConfigFromConfig,
  ): Layer.Layer<DynamoStreamsClient, Config.ConfigError> =>
    Layer.effect(
      DynamoStreamsClient,
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
