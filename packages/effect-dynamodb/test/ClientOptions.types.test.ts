/**
 * #190: what the layers accept. The SDK's own `requestHandler` type admits
 * `Record<string, unknown>`, under which a misspelt option compiles and the call has
 * no timeout, so the layers narrow it.
 */

import { describe, it } from "@effect/vitest"
import { Config } from "effect"
import { DynamoStreamsClient } from "../src/change-feed/DynamoStreamsClient.js"
import { DynamoClient } from "../src/DynamoClient.js"
import type { RequestHandlerInstance } from "../src/internal/ClientOptions.js"

const region = "us-east-1"
const handler = {} as RequestHandlerInstance

describe("ClientOptions types", () => {
  it("DynamoClient.layer", () => {
    DynamoClient.layer({ region })
    DynamoClient.layer({ region, maxAttempts: 2 })
    DynamoClient.layer({ region, requestHandler: { socketTimeout: 100 } })
    DynamoClient.layer({
      region,
      requestHandler: {
        connectionTimeout: 100,
        socketTimeout: 100,
        requestTimeout: 100,
        throwOnRequestTimeout: true,
      },
    })
    DynamoClient.layer({ region, requestHandler: handler })
    // @ts-expect-error a misspelt option must not compile
    DynamoClient.layer({ region, requestHandler: { socketTimout: 100 } })
    // @ts-expect-error
    DynamoClient.layer({ region, maxAttempts: "2" })
  })

  it("DynamoClient.layerConfig", () => {
    const timeout = Config.Int("TIMEOUT")
    DynamoClient.layerConfig({ region: Config.String("REGION") })
    DynamoClient.layerConfig({ region: Config.String("REGION"), maxAttempts: Config.Int("N") })
    DynamoClient.layerConfig({
      region: Config.String("REGION"),
      requestHandler: {
        connectionTimeout: timeout,
        socketTimeout: timeout,
        requestTimeout: timeout,
        throwOnRequestTimeout: Config.Boolean("THROW"),
      },
    })
    DynamoClient.layerConfig({
      region: Config.String("REGION"),
      requestHandler: handler,
    })
    DynamoClient.layerConfig({
      region: Config.String("REGION"),
      // @ts-expect-error a misspelt option must not compile
      requestHandler: { socketTimout: timeout },
    })
    DynamoClient.layerConfig({
      region: Config.String("REGION"),
      // @ts-expect-error a value here is read through Config
      requestHandler: { socketTimeout: 100 },
    })
    // @ts-expect-error a value here is read through Config
    DynamoClient.layerConfig({ region: Config.String("REGION"), maxAttempts: 2 })
  })

  it("DynamoStreamsClient.layer", () => {
    DynamoStreamsClient.layer({ region, maxAttempts: 2 })
    DynamoStreamsClient.layer({ region, requestHandler: { socketTimeout: 100 } })
    DynamoStreamsClient.layer({ region, requestHandler: handler })
    // @ts-expect-error a misspelt option must not compile
    DynamoStreamsClient.layer({ region, requestHandler: { socketTimout: 100 } })
  })

  it("DynamoStreamsClient.layerConfig", () => {
    DynamoStreamsClient.layerConfig({
      region: Config.String("REGION"),
      requestHandler: { socketTimeout: Config.Int("TIMEOUT") },
      maxAttempts: Config.Int("N"),
    })
    DynamoStreamsClient.layerConfig({
      region: Config.String("REGION"),
      // @ts-expect-error a misspelt option must not compile
      requestHandler: { socketTimout: Config.Int("TIMEOUT") },
    })
  })
})
