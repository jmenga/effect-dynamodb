/**
 * A packed value that needs a codec with no registered compressor fails with a
 * `ValidationError` whose `cause` is a `CompressorNotRegistered` (#147): the
 * error channels stay those of 1.25.0, and the cause names the codec, the
 * direction and the attribute.
 */

import { CompressorNotRegistered, ValidationError } from "@effect-dynamodb/schema/Errors.js"
import { Exit } from "effect"
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

/**
 * Assert `exit` died with the `[EDD-9078]` configuration error a bind (or an
 * unbound stream's first operation) raises when a configured codec is not
 * registered, and return its message.
 */
export const unregisteredCodecDefect = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) throw new Error("expected a defect, got a success")
  const reason = exit.cause.reasons.find((r) => r._tag === "Die")
  if (reason === undefined || reason._tag !== "Die") {
    throw new Error(
      `expected a Die reason, got ${exit.cause.reasons.map((r) => r._tag).join(", ")}`,
    )
  }
  const message = String((reason.defect as Error).message ?? reason.defect)
  expect(message).toContain("[EDD-9078]")
  return message
}
