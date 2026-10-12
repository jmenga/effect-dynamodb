/**
 * A packed value that needs a codec with no registered compressor fails with a
 * `ValidationError` whose `cause` is a `CompressorNotRegistered` (#147): the
 * error channels stay those of 1.25.0, and the cause names the codec, the
 * direction and the attribute.
 */

import { CompressorNotRegistered, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { expect } from "vitest"

/** Assert `error` is a missing-compressor failure and return its cause. */
export const missingCompressor = (error: unknown): CompressorNotRegistered => {
  expect(error).toBeInstanceOf(ValidationError)
  const validation = error as ValidationError
  expect(validation.cause).toBeInstanceOf(CompressorNotRegistered)
  const cause = validation.cause as CompressorNotRegistered
  // The ValidationError is attributed exactly as its cause.
  expect(validation.entityType).toBe(cause.entityType)
  expect(validation.operation).toBe(cause.operation)
  return cause
}
