/**
 * What each client layer signs with, given `credentials`. The layers hand the
 * SDK the caller's own object, never a copy: the SDK reads it for every request,
 * so keys changed in place, keys held in getters and a provider function an
 * untyped caller passes all reach the wire, as they did on 1.40.0. A copy taken
 * when the layer is built broke all three.
 */

import { describe, expect, it } from "@effect/vitest"
import { Config, Effect, type Layer } from "effect"
import { DynamoStreamsClient } from "../src/change-feed/DynamoStreamsClient.js"
import { DynamoClient } from "../src/DynamoClient.js"
import type { Credentials } from "../src/internal/ClientOptions.js"
import { localServer } from "./helpers/LocalServer.js"

type Via = "layer" | "layerConfig"

const keyIdOf = (authorization: unknown) => /Credential=([^/]+)\//.exec(String(authorization))?.[1]

const clients = {
  DynamoClient: {
    layer: (endpoint: string, credentials: Credentials, via: Via) =>
      via === "layer"
        ? DynamoClient.layer({ region: "us-east-1", endpoint, credentials, maxAttempts: 1 })
        : DynamoClient.layerConfig({
            region: Config.succeed("us-east-1"),
            endpoint: Config.succeed(endpoint),
            credentials: Config.succeed(credentials),
            maxAttempts: Config.succeed(1),
          }),
    call: Effect.gen(function* () {
      const client = yield* DynamoClient
      yield* client.getItem({ TableName: "t", Key: { pk: { S: "a" } } })
    }),
  },
  DynamoStreamsClient: {
    layer: (endpoint: string, credentials: Credentials, via: Via) =>
      via === "layer"
        ? DynamoStreamsClient.layer({ region: "us-east-1", endpoint, credentials, maxAttempts: 1 })
        : DynamoStreamsClient.layerConfig({
            region: Config.succeed("us-east-1"),
            endpoint: Config.succeed(endpoint),
            credentials: Config.succeed(credentials),
            maxAttempts: Config.succeed(1),
          }),
    call: Effect.gen(function* () {
      const client = yield* DynamoStreamsClient
      yield* client.getRecords({ ShardIterator: "iterator" })
    }),
  },
} as const

/**
 * Two calls through one layer, `between` run between them: the key id and the
 * session token each request was signed with. The local server answers every
 * request with an empty success, so a call fails only if signing does.
 */
const twoCalls = (
  name: keyof typeof clients,
  credentials: Credentials,
  options?: { readonly via?: Via; readonly between?: () => void },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* localServer()
      const client = clients[name]
      const layer = client.layer(server.endpoint, credentials, options?.via ?? "layer")
      const call: Effect.Effect<void, unknown, DynamoClient | DynamoStreamsClient> = client.call
      yield* Effect.gen(function* () {
        yield* Effect.exit(call)
        options?.between?.()
        yield* Effect.exit(call)
      }).pipe(Effect.provide(layer as Layer.Layer<DynamoClient | DynamoStreamsClient, unknown>))
      return server.requests.map((request) => [
        keyIdOf(request.headers.authorization),
        request.headers["x-amz-security-token"],
      ])
    }),
  )

describe.each(["DynamoClient", "DynamoStreamsClient"] as const)("%s credentials", (name) => {
  it.live.each(["layer", "layerConfig"] as const)("a session token, through %s", (via) =>
    Effect.gen(function* () {
      const credentials = { accessKeyId: "AKIDTOKEN", secretAccessKey: "s", sessionToken: "T1" }
      expect(yield* twoCalls(name, credentials, { via })).toEqual([
        ["AKIDTOKEN", "T1"],
        ["AKIDTOKEN", "T1"],
      ])
    }),
  )

  it.live("no session token for one left undefined or null", () =>
    Effect.gen(function* () {
      const keys = { accessKeyId: "AKIDNONE", secretAccessKey: "s" }
      for (const sessionToken of [undefined, null]) {
        expect(yield* twoCalls(name, { ...keys, sessionToken })).toEqual([
          ["AKIDNONE", undefined],
          ["AKIDNONE", undefined],
        ])
      }
    }),
  )

  it.live("keys changed in place between two calls", () =>
    Effect.gen(function* () {
      const credentials = { accessKeyId: "AKIDOLD", secretAccessKey: "old", sessionToken: "OLD" }
      const between = () => {
        credentials.accessKeyId = "AKIDNEW"
        credentials.secretAccessKey = "new"
        credentials.sessionToken = "NEW"
      }
      expect(yield* twoCalls(name, credentials, { between })).toEqual([
        ["AKIDOLD", "OLD"],
        ["AKIDNEW", "NEW"],
      ])
    }),
  )

  it.live("keys held in getters", () =>
    Effect.gen(function* () {
      class Held {
        get accessKeyId() {
          return "AKIDHELD"
        }
        get secretAccessKey() {
          return "s"
        }
        get sessionToken() {
          return "HELD"
        }
      }
      expect(yield* twoCalls(name, new Held())).toEqual([
        ["AKIDHELD", "HELD"],
        ["AKIDHELD", "HELD"],
      ])
    }),
  )

  it.live.each(["layer", "layerConfig"] as const)(
    "a provider function an untyped caller passes, through %s",
    (via) =>
      Effect.gen(function* () {
        const provider = async () => ({
          accessKeyId: "AKIDPROVIDED",
          secretAccessKey: "s",
          sessionToken: "PROVIDED",
        })
        expect(yield* twoCalls(name, provider as unknown as Credentials, { via })).toEqual([
          ["AKIDPROVIDED", "PROVIDED"],
          ["AKIDPROVIDED", "PROVIDED"],
        ])
      }),
  )
})
