/**
 * @effect-dynamodb/schema — Pure schema/relationship-derivation layer.
 *
 * This package contains the AWS-free core of effect-dynamodb: the domain-model
 * annotation system (`DynamoModel`), the application namespace (`DynamoSchema`),
 * composite key composition (`KeyComposer`), tagged errors, and the pure
 * `Entity` / `Aggregate` definition builders with their derived `inputSchema` /
 * `updateSchema` / `createSchema` codecs.
 *
 * It has ZERO dependency on the AWS SDK — neither at runtime nor in its emitted
 * `.d.ts` surface — so consumers can import an entity/aggregate's derived schemas
 * (e.g. for HttpApi payloads or validation) without pulling the AWS SDK into
 * their dependency graph or type surface.
 *
 * The full `effect-dynamodb` package depends on and re-exports everything here,
 * adding the AWS runtime (DynamoClient, CRUD operations, Batch/Transaction/
 * Collection, Marshaller).
 */

export type { AggregateDefinition, BoundAggregate } from "./Aggregate.js"
export * as Aggregate from "./Aggregate.js"
export * as DynamoModel from "./DynamoModel.js"
export type { Casing, DynamoSchema as DynamoSchemaType } from "./DynamoSchema.js"
export * as DynamoSchema from "./DynamoSchema.js"
export type { EmbedderService } from "./Embedder.js"
export { Embedder } from "./Embedder.js"
export type {
  AnyRefValue,
  EntityDefinition,
  EntityDefinition as EntityType,
} from "./Entity.js"
export * as Entity from "./Entity.js"
export {
  AggregateAssemblyError,
  AggregateDecompositionError,
  AggregateTransactionOverflow,
  CascadePartialFailure,
  CompositeKeyHoleError,
  CompositeNullableError,
  ConditionalCheckFailed,
  DynamoError,
  DynamoValidationError,
  EmbeddingError,
  InternalServerError,
  ItemDeleted,
  ItemNotDeleted,
  ItemNotFound,
  makeCompositeKeyHoleError,
  makeCompositeNullableError,
  OptimisticLockError,
  RefNotFound,
  ResourceNotFoundError,
  StaleAppend,
  ThrottlingError,
  TransactionCancelled,
  TransactionOverflow,
  UniqueConstraintViolation,
  ValidationError,
  VectorIndexBackfilling,
  VersionConflict,
} from "./Errors.js"
export type {
  AppendInputType,
  AppendSuccess,
  EntityInputType,
  EntityKeyType,
  EntityRecordType,
  EntityRefInputType,
  EntityRefUpdateType,
  EntityUpdateType,
  IndexPkComposites,
  IndexPkInput,
  IndexSkComposites,
  ModelType,
  PrimaryKeyComposites,
  RefErrors,
  SystemFieldsType,
} from "./internal/EntityTypes.js"
export type { GsiConfig, IndexDefinition, KeyPart } from "./KeyComposer.js"
export * as KeyComposer from "./KeyComposer.js"
export type { ProjectionResult } from "./Projection.js"
export * as Projection from "./Projection.js"
export type {
  DistanceFunction,
  Similarity,
  VectorFilterInput,
  VectorFilterOperand,
  VectorIndexConfig,
  VectorIndexDefinition,
  VectorSourceConfig,
} from "./VectorIndex.js"
export * as VectorIndex from "./VectorIndex.js"
