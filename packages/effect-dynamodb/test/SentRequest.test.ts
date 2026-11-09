/**
 * A failed request's input as sent: recorded by `Capacity`'s instrumented client, after it added
 * `ReturnConsumedCapacity`, and found again from the error or its cause.
 */

import { describe, expect, it } from "@effect/vitest"
import { DynamoError } from "@effect-dynamodb/schema/Errors.js"
import { Effect, Layer } from "effect"
import * as ConsumedCapacity from "../src/ConsumedCapacity.js"
import * as Capacity from "../src/internal/Capacity.js"
import * as SentRequest from "../src/internal/SentRequest.js"
import { mockDynamoClientLayer } from "./helpers/MockDynamoClient.js"

describe("SentRequest", () => {
  it("finds the input from the error, or from its cause", () => {
    const cause = new Error("refused")
    const error = new DynamoError({ operation: "PutItem", cause })
    const input = { TableName: "t" }
    SentRequest.remember(error, input)
    expect(SentRequest.inputOf(error)).toBe(input)
    expect(SentRequest.inputOf(new DynamoError({ operation: "again", cause }))).toBe(input)
    expect(SentRequest.inputOf(new DynamoError({ operation: "other", cause: new Error() }))).toBe(
      undefined,
    )
    expect(SentRequest.inputOf("not an object")).toBe(undefined)
  })

  describe.each([
    ["capacity reporting off", Layer.empty, undefined],
    ["capacity reporting on", ConsumedCapacity.layer(), "TOTAL"],
    ["capacity reporting on, by index", ConsumedCapacity.layer({ level: "indexes" }), "INDEXES"],
  ] as const)("%s", (_label, capacity, flag) => {
    it.effect("the instrumented client records what the client received, on failure only", () =>
      Effect.gen(function* () {
        const received: Array<unknown> = []
        const refused = new DynamoError({ operation: "PutItem", cause: new Error("refused") })
        const client = mockDynamoClientLayer({
          putItem: (input) =>
            Effect.suspend(() => {
              received.push(input)
              return input.TableName === "fails" ? Effect.fail(refused) : Effect.succeed({} as any)
            }),
        })
        const error = yield* Effect.gen(function* () {
          const instrumented = yield* Capacity.client
          yield* instrumented.putItem({ TableName: "ok", Item: {} })
          return yield* instrumented.putItem({ TableName: "fails", Item: {} }).pipe(Effect.flip)
        }).pipe(Effect.provide(Layer.merge(client, capacity)))
        expect(error).toBe(refused)
        const sent = SentRequest.inputOf(error)
        expect(sent).toBe(received[1])
        expect(sent).toEqual({
          TableName: "fails",
          Item: {},
          ...(flag === undefined ? {} : { ReturnConsumedCapacity: flag }),
        })
      }),
    )
  })
})
