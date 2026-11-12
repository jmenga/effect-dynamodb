/**
 * What each client layer signs with, given `credentials`. The layers hand the
 * SDK the caller's own object, never a copy: the SDK reads it for every request,
 * so keys changed in place, keys held in getters and a provider function an
 * untyped caller passes all reach the wire, as they did on 1.40.0. A copy taken
 * when the layer is built broke all three.
 *
 * The local server checks each request's SigV4 signature itself, so a secret
 * that stopped following the caller's object fails here as a key id or token
 * would.
 */

import { describe, expect, it } from "@effect/vitest"
import { Config, Effect, type Layer } from "effect"
import { DynamoStreamsClient } from "../src/change-feed/DynamoStreamsClient.js"
import { DynamoClient } from "../src/DynamoClient.js"
import type { Credentials } from "../src/internal/ClientOptions.js"
import { localServer } from "./helpers/LocalServer.js"
import { signedWith, wire } from "./helpers/SigV4.js"

type Via = "layer" | "layerConfig"
const vias = ["layer", "layerConfig"] as const

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
 * The requests of two calls through one layer, `between` run between them. The
 * local server answers every request with an empty success, so a call fails
 * only if signing does, and then sends nothing.
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
      return server.requests
    }),
  )

describe.each(["DynamoClient", "DynamoStreamsClient"] as const)("%s credentials", (name) => {
  it.live("the server's signature check holds the SDK's signature to its secret", () =>
    Effect.gen(function* () {
      const [request] = yield* twoCalls(name, { accessKeyId: "AKIDCHECK", secretAccessKey: "s" })
      expect(request).toBeDefined()
      expect(signedWith(request!, "s")).toBe(true)
      expect(signedWith(request!, "t")).toBe(false)
    }),
  )

  it.live.each(vias)("a session token, through %s", (via) =>
    Effect.gen(function* () {
      const credentials = { accessKeyId: "AKIDTOKEN", secretAccessKey: "s", sessionToken: "T1" }
      expect(wire(yield* twoCalls(name, credentials, { via }), ["s", "s"])).toEqual([
        ["AKIDTOKEN", "T1", true],
        ["AKIDTOKEN", "T1", true],
      ])
    }),
  )

  it.live("no session token for one left undefined or null", () =>
    Effect.gen(function* () {
      const keys = { accessKeyId: "AKIDNONE", secretAccessKey: "s" }
      for (const sessionToken of [undefined, null]) {
        expect(wire(yield* twoCalls(name, { ...keys, sessionToken }), ["s", "s"])).toEqual([
          ["AKIDNONE", undefined, true],
          ["AKIDNONE", undefined, true],
        ])
      }
    }),
  )

  it.live.each(vias)("every key changed in place between two calls, through %s", (via) =>
    Effect.gen(function* () {
      const credentials = { accessKeyId: "AKIDOLD", secretAccessKey: "old", sessionToken: "OLD" }
      const between = () => {
        credentials.accessKeyId = "AKIDNEW"
        credentials.secretAccessKey = "new"
        credentials.sessionToken = "NEW"
      }
      expect(wire(yield* twoCalls(name, credentials, { via, between }), ["old", "new"])).toEqual([
        ["AKIDOLD", "OLD", true],
        ["AKIDNEW", "NEW", true],
      ])
    }),
  )

  it.live.each(vias)("the secret alone changed in place, through %s", (via) =>
    Effect.gen(function* () {
      const credentials = { accessKeyId: "AKIDSAME", secretAccessKey: "old" }
      const between = () => {
        credentials.secretAccessKey = "new"
      }
      const requests = yield* twoCalls(name, credentials, { via, between })
      expect(wire(requests, ["old", "new"])).toEqual([
        ["AKIDSAME", undefined, true],
        ["AKIDSAME", undefined, true],
      ])
      expect(signedWith(requests[1]!, "old")).toBe(false)
    }),
  )

  it.live.each(vias)("keys held in getters, through %s", (via) =>
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
      expect(wire(yield* twoCalls(name, new Held(), { via }), ["s", "s"])).toEqual([
        ["AKIDHELD", "HELD", true],
        ["AKIDHELD", "HELD", true],
      ])
    }),
  )

  it.live.each(vias)("a provider function an untyped caller passes, through %s", (via) =>
    Effect.gen(function* () {
      const provider = async () => ({
        accessKeyId: "AKIDPROVIDED",
        secretAccessKey: "s",
        sessionToken: "PROVIDED",
      })
      const requests = yield* twoCalls(name, provider as unknown as Credentials, { via })
      expect(wire(requests, ["s", "s"])).toEqual([
        ["AKIDPROVIDED", "PROVIDED", true],
        ["AKIDPROVIDED", "PROVIDED", true],
      ])
    }),
  )
})
