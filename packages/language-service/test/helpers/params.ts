import type { DetectedOperation } from "../../src/core/OperationDetector"
import { buildParams, type DynamoDBParams } from "../../src/core/ParamsBuilder"

/**
 * `buildParams` returns `undefined` for an operation it cannot resolve (no
 * entity, or an accessor with no matching index). Every case in the test suite
 * supplies a resolvable operation, so this asserts that up front rather than
 * making each assertion carry a non-null assertion.
 */
export const buildParamsOrThrow = (op: DetectedOperation): DynamoDBParams => {
  const params = buildParams(op)
  if (params === undefined) {
    throw new Error(`buildParams returned undefined for operation type "${op.type}"`)
  }
  return params
}
