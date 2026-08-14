export * as DynamoModel from "@effect-dynamodb/schema/DynamoModel.js"
export type {
  Casing,
  DynamoSchema as DynamoSchemaType,
} from "@effect-dynamodb/schema/DynamoSchema.js"
export * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
export type { EmbedderService } from "@effect-dynamodb/schema/Embedder.js"
export { Embedder } from "@effect-dynamodb/schema/Embedder.js"
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
} from "@effect-dynamodb/schema/Errors.js"
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
} from "@effect-dynamodb/schema/internal/EntityTypes.js"
export type { GsiConfig, IndexDefinition, KeyPart } from "@effect-dynamodb/schema/KeyComposer.js"
export * as KeyComposer from "@effect-dynamodb/schema/KeyComposer.js"
export type { ProjectionResult } from "@effect-dynamodb/schema/Projection.js"
export * as Projection from "@effect-dynamodb/schema/Projection.js"
export type {
  DistanceFunction,
  Similarity,
  VectorFilterInput,
  VectorFilterOperand,
  VectorIndexConfig,
  VectorIndexDefinition,
  VectorSourceConfig,
} from "@effect-dynamodb/schema/VectorIndex.js"
export * as VectorIndex from "@effect-dynamodb/schema/VectorIndex.js"
export type { BoundAggregate } from "./Aggregate.js"
export * as Aggregate from "./Aggregate.js"
export type { BatchRetryConfig } from "./Batch.js"
export * as Batch from "./Batch.js"
export type { Collection as CollectionType } from "./Collection.js"
export * as Collection from "./Collection.js"
export type {
  DynamoClientError,
  DynamoClientService,
  TableLike,
  TableOperations,
  TypedClient,
} from "./DynamoClient.js"
export { DynamoClient } from "./DynamoClient.js"
export type {
  BoundEntity,
  Entity as EntityType,
  EntityDelete,
  EntityGet,
  EntityPut,
  EntityUpdate,
  TransactableInfo,
} from "./Entity.js"
export * as Entity from "./Entity.js"
export * as EventStore from "./EventStore.js"
export type {
  ConditionInput,
  ExpressionResult,
  UpdateInput,
} from "./Expression.js"
export * as Expression from "./Expression.js"
export type {
  BoundQuery,
  BoundQueryBase,
  BoundQueryWithWhere,
  SkConditionOps,
} from "./internal/BoundQuery.js"
export { makeBoundQuery } from "./internal/BoundQuery.js"
export type {
  BoundVectorQuery,
  BoundVectorQueryCombinators,
  BoundVectorQueryTerminals,
  BoundVectorQueryWithPartition,
  VectorHit,
  VectorSearchError,
} from "./internal/BoundVectorQuery.js"
export type {
  CompileResult,
  ConditionOps,
  ConditionShorthand,
  Expr,
} from "./internal/Expr.js"
export {
  compileExpr,
  createConditionOps,
  isExpr,
  parseShorthand,
  parseSimpleShorthand,
} from "./internal/Expr.js"
export type {
  ArrayPath,
  DeepPick,
  Path,
  PathBuilder,
  PathKeys,
  SizeOperand,
} from "./internal/PathBuilder.js"
export { compilePath, createPathBuilder, isPath } from "./internal/PathBuilder.js"
export * as Marshaller from "./Marshaller.js"
export * as Query from "./Query.js"
export type { Table as TableType, TableConfig } from "./Table.js"
export * as Table from "./Table.js"
export type { ConditionCheckOp } from "./Transaction.js"
export * as Transaction from "./Transaction.js"
export type {
  EmulatedVectorIndex,
  EmulationOptions,
} from "./VectorSearchEmulation.js"
export * as VectorSearchEmulation from "./VectorSearchEmulation.js"
