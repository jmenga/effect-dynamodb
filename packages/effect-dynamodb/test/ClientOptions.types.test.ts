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

  // Temporary credentials (an assumed role) come with a session token, which the
  // layers' credentials left out of their type.
  it("credentials, with or without a session token", () => {
    const keys = { accessKeyId: "a", secretAccessKey: "s" }
    const token = "t" as string | undefined
    DynamoClient.layer({ region, credentials: keys })
    DynamoClient.layer({ region, credentials: { accessKeyId: "a", secretAccessKey: "s" } })
    DynamoClient.layer({
      region,
      credentials: { accessKeyId: "a", secretAccessKey: "s", sessionToken: "t" },
    })
    DynamoClient.layer({ region, credentials: { ...keys, sessionToken: token } })
    // A token decoded from a source that holds null for none.
    const nullable = { ...keys, sessionToken: null as string | null }
    DynamoClient.layer({ region, credentials: nullable })
    DynamoClient.layer({ region, credentials: { ...keys, sessionToken: null } })
    DynamoClient.layer({
      region,
      // @ts-expect-error an unknown key must not compile
      credentials: { accessKeyId: "a", secretAccessKey: "s", sesionToken: "t" },
    })
    DynamoClient.layer({
      region,
      // @ts-expect-error a token is a string
      credentials: { accessKeyId: "a", secretAccessKey: "s", sessionToken: 1 },
    })
    // @ts-expect-error the secret is required
    DynamoClient.layer({ region, credentials: { accessKeyId: "a", sessionToken: "t" } })

    DynamoStreamsClient.layer({ region, credentials: keys })
    DynamoStreamsClient.layer({
      region,
      credentials: { accessKeyId: "a", secretAccessKey: "s", sessionToken: "t" },
    })
    DynamoStreamsClient.layer({
      region,
      // @ts-expect-error an unknown key must not compile
      credentials: { accessKeyId: "a", secretAccessKey: "s", sesionToken: "t" },
    })
  })

  it("credentials read through Config, with or without a session token", () => {
    const keys = { accessKeyId: Config.String("KEY"), secretAccessKey: Config.String("SECRET") }
    const token = Config.String("TOKEN")
    DynamoClient.layerConfig({ region: Config.String("REGION"), credentials: Config.all(keys) })
    DynamoClient.layerConfig({
      region: Config.String("REGION"),
      credentials: Config.all({ ...keys, sessionToken: token }),
    })
    DynamoClient.layerConfig({
      region: Config.String("REGION"),
      credentials: Config.all({ ...keys, sessionToken: token.pipe(Config.withDefault(undefined)) }),
    })
    DynamoClient.layerConfig({
      region: Config.String("REGION"),
      credentials: Config.all({ ...keys, sessionToken: token.pipe(Config.withDefault(null)) }),
    })
    DynamoClient.layerConfig({
      region: Config.String("REGION"),
      // @ts-expect-error a token is a string
      credentials: Config.all({ ...keys, sessionToken: Config.Int("TOKEN") }),
    })
    DynamoStreamsClient.layerConfig({
      region: Config.String("REGION"),
      credentials: Config.all({ ...keys, sessionToken: token }),
    })
    DynamoStreamsClient.layerConfig({
      region: Config.String("REGION"),
      // @ts-expect-error a token is a string
      credentials: Config.all({ ...keys, sessionToken: Config.Int("TOKEN") }),
    })
  })
})
