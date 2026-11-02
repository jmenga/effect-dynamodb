/**
 * `effect-dynamodb/blob/s3` — the S3 `BlobStore` offloaded attribute values
 * (`DynamoModel.Packed({ external })`, `DynamoModel.External()`) are written
 * to and read from.
 *
 * Needs `@aws-sdk/client-s3` (an optional peer dependency, `^3.1104.0`); the
 * main `effect-dynamodb` entry never imports it. The bucket must have
 * **versioning enabled**: every upload makes a new version and the pointer in
 * the item names it, so a stored pointer never changes meaning. An upload to
 * a bucket that answers without a real `VersionId` (never versioned, or
 * suspended) fails with `BlobStoreError { reason: "Unversioned" }`, and the
 * object it wrote is deleted.
 *
 * @example
 * ```typescript
 * import { DynamoClient } from "effect-dynamodb"
 * import * as S3BlobStore from "effect-dynamodb/blob/s3"
 *
 * const AppLayer = Layer.mergeAll(
 *   DynamoClient.layer({ region: "eu-west-1" }),
 *   S3BlobStore.layer({
 *     bucket: "documents-blobs",
 *     prefix: "prod/",
 *     clientConfig: { region: "eu-west-1" },
 *   }),
 * )
 *
 * // from configuration (environment variables, …)
 * const FromConfig = S3BlobStore.layerConfig({
 *   bucket: Config.String("BLOB_BUCKET"),
 *   prefix: Config.String("BLOB_PREFIX"),
 *   region: Config.String("AWS_REGION"),
 *   // optional static credentials (none: the SDK's default credential chain)
 *   credentials: Config.all({
 *     accessKeyId: Config.String("BLOB_ACCESS_KEY_ID"),
 *     secretAccessKey: Config.String("BLOB_SECRET_ACCESS_KEY"),
 *   }),
 * })
 * ```
 *
 * Presigned URLs (`BlobHandle.presignedUrl`) need the presigner, which the
 * library never imports: `presign: { getSignedUrl }` from
 * `@aws-sdk/s3-request-presigner`.
 *
 * The store needs `s3:PutObject`, `s3:AbortMultipartUpload`,
 * `s3:GetObjectVersion`, `s3:ListBucket`, `s3:DeleteObject`,
 * `s3:DeleteObjectVersion`, `s3:GetObjectVersionTagging`,
 * `s3:PutObjectVersionTagging` and `s3:ListBucketVersions` on the prefix
 * (and `kms:GenerateDataKey` / `kms:Decrypt` for SSE-KMS). Object Lock and
 * MFA Delete make rollback and GC deletes fail; lifecycle rules that expire
 * versions (`NoncurrentVersionExpiration`, `Expiration`) must never apply to
 * the offload prefix.
 *
 * @module
 */

import type { S3ClientConfig } from "@aws-sdk/client-s3"
import { Config, type Duration, Effect, Layer, Option, type Scope } from "effect"
import { BlobStore } from "../BlobStore.js"
import { type BlobStoreService, validateService } from "../internal/BlobStoreContract.js"
import { type Credentials, readCredentials } from "../internal/ClientOptions.js"
import {
  acquireClient,
  makeService,
  type ResolvedOptions,
  resolveOptions,
  type S3BlobStoreOptions,
} from "./S3BlobStore.js"

export type {
  S3BlobStoreOptions,
  S3GetSignedUrl,
  S3ServerSideEncryption,
} from "./S3BlobStore.js"

/**
 * Options of {@link layerConfig}: the store's settings read from Effect
 * `Config` (environment variables, …), plus the static ones. `region`,
 * `endpoint`, `forcePathStyle` and `credentials` configure the `S3Client` the
 * layer builds and owns, over `clientConfig`. An optional setting whose
 * config is missing takes its default.
 */
export interface S3BlobStoreConfig
  extends Omit<
    S3BlobStoreOptions,
    | "bucket"
    | "prefix"
    | "client"
    | "partSize"
    | "uploadConcurrency"
    | "readConcurrency"
    | "writeConcurrency"
    | "maxUploadAge"
  > {
  readonly bucket: Config.Config<string>
  readonly prefix?: Config.Config<string> | undefined
  readonly region?: Config.Config<string> | undefined
  /** An endpoint override (MinIO, LocalStack, …). */
  readonly endpoint?: Config.Config<string> | undefined
  /** Path-style addressing (MinIO). */
  readonly forcePathStyle?: Config.Config<boolean> | undefined
  /**
   * Static credentials, with a `sessionToken` when they are temporary (an
   * assumed role), read as `DynamoClient.layerConfig` reads its own: with none
   * of them in the provider, the SDK's default credential chain applies; with
   * one of them there and another missing, the layer fails with the
   * `Config`'s error for what is missing. The SDK client gets them as they
   * are, and AWS's reply to a refused signature, which can quote the session
   * token, is redacted from every error.
   */
  readonly credentials?: Config.Config<Credentials> | undefined
  readonly partSize?: Config.Config<number> | undefined
  readonly uploadConcurrency?: Config.Config<number> | undefined
  readonly readConcurrency?: Config.Config<number> | undefined
  readonly writeConcurrency?: Config.Config<number> | undefined
  readonly maxUploadAge?: Config.Config<Duration.Duration> | undefined
}

const build = (
  where: string,
  resolved: ResolvedOptions,
): Effect.Effect<BlobStoreService, never, Scope.Scope> =>
  Effect.map(acquireClient(resolved), (client) =>
    validateService(where, makeService(resolved, client)),
  )

/**
 * The S3 store, in a scope: over the caller's `client` (left open), or an
 * `S3Client` built from `clientConfig` and destroyed when the scope closes.
 *
 * @throws `[EDD-9116]` (when called) for invalid options: an unknown key; an
 *   empty `bucket`; a `prefix` over 256 bytes or starting with `/`; both
 *   `client` and `clientConfig`; a `partSize` outside 5 MiB … 5 GiB; a
 *   concurrency that is not a positive integer; a `maxUploadAge` outside 1
 *   minute … 7 days; an invalid `serverSideEncryption`, `storageClass`,
 *   `notFoundRetry` or `presign`.
 */
export const make = (
  options: S3BlobStoreOptions,
): Effect.Effect<BlobStoreService, never, Scope.Scope> =>
  build("S3BlobStore.make", resolveOptions("S3BlobStore.make", options))

/**
 * A layer providing the S3 store as the `BlobStore` service (see
 * {@link make}; a client it builds lives as long as the layer).
 *
 * @throws `[EDD-9116]` (when called) for invalid options.
 */
export const layer = (options: S3BlobStoreOptions): Layer.Layer<BlobStore> => {
  const resolved = resolveOptions("S3BlobStore.layer", options)
  return Layer.effect(BlobStore, build("S3BlobStore.layer", resolved))
}

const optional = <A>(
  config: Config.Config<A> | undefined,
): Effect.Effect<A | undefined, Config.ConfigError> =>
  Effect.gen(function* () {
    if (config === undefined) return undefined
    return Option.getOrUndefined(yield* Config.option(config))
  })

/**
 * A layer providing the S3 store, its settings read from Effect `Config`.
 * The `S3Client` is built from `clientConfig` with `region`, `endpoint`,
 * `forcePathStyle` and `credentials` laid over it, and destroyed with the
 * layer.
 *
 * Invalid settings are `[EDD-9116]` defects when the layer is built; a config
 * that cannot be read is its `ConfigError`.
 */
export const layerConfig = (
  config: S3BlobStoreConfig,
): Layer.Layer<BlobStore, Config.ConfigError> =>
  Layer.effect(
    BlobStore,
    Effect.gen(function* () {
      const {
        bucket,
        prefix,
        region,
        endpoint,
        forcePathStyle,
        credentials,
        partSize,
        uploadConcurrency,
        readConcurrency,
        writeConcurrency,
        maxUploadAge,
        clientConfig,
        ...rest
      } = config
      const values = {
        bucket: yield* bucket,
        prefix: yield* optional(prefix),
        region: yield* optional(region),
        endpoint: yield* optional(endpoint),
        forcePathStyle: yield* optional(forcePathStyle),
        credentials: yield* readCredentials(credentials),
        partSize: yield* optional(partSize),
        uploadConcurrency: yield* optional(uploadConcurrency),
        readConcurrency: yield* optional(readConcurrency),
        writeConcurrency: yield* optional(writeConcurrency),
        maxUploadAge: yield* optional(maxUploadAge),
      }
      const client: S3ClientConfig = {
        ...clientConfig,
        ...(values.region === undefined ? {} : { region: values.region }),
        ...(values.endpoint === undefined ? {} : { endpoint: values.endpoint }),
        ...(values.forcePathStyle === undefined ? {} : { forcePathStyle: values.forcePathStyle }),
        // The object itself, as `DynamoClient.layerConfig` passes its own: the
        // SDK's type has no `undefined` or `null` token, and sends none for either.
        ...(values.credentials === undefined
          ? {}
          : { credentials: values.credentials as NonNullable<S3ClientConfig["credentials"]> }),
      }
      const options: S3BlobStoreOptions = {
        ...rest,
        bucket: values.bucket,
        clientConfig: client,
        ...(values.prefix === undefined ? {} : { prefix: values.prefix }),
        ...(values.partSize === undefined ? {} : { partSize: values.partSize }),
        ...(values.uploadConcurrency === undefined
          ? {}
          : { uploadConcurrency: values.uploadConcurrency }),
        ...(values.readConcurrency === undefined
          ? {}
          : { readConcurrency: values.readConcurrency }),
        ...(values.writeConcurrency === undefined
          ? {}
          : { writeConcurrency: values.writeConcurrency }),
        ...(values.maxUploadAge === undefined ? {} : { maxUploadAge: values.maxUploadAge }),
      }
      return yield* build(
        "S3BlobStore.layerConfig",
        resolveOptions("S3BlobStore.layerConfig", options),
      )
    }),
  )
