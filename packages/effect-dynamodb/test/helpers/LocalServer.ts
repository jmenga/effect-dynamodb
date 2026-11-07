/**
 * A local HTTP server speaking enough of DynamoDB's JSON protocol to test what the
 * real SDK client does on the wire: which requests arrive, how many connections it
 * opens, and when the server sees one end. Given `upstream`, it passes requests on
 * to that endpoint (DynamoDB Local) unless `reply` says otherwise.
 *
 * `until` waits on what actually happened, however long that takes under load: it
 * re-checks on every server event, and a test that never gets there times out.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http"
import type { AddressInfo, Socket } from "node:net"
import { Effect, type Scope } from "effect"

/** What the server does with a request. */
export type Reply =
  /** Never answer it. It reaches nothing: {@link LocalServer.land} can deliver it later. */
  | { readonly _tag: "Hang" }
  /** Pass it upstream, so a write is applied, and never tell the client. */
  | { readonly _tag: "ApplyAndHang" }
  /** Drop the connection without answering. */
  | { readonly _tag: "Reset" }
  /** Answer it, here. */
  | { readonly _tag: "Answer"; readonly status: number; readonly body: string }
  /** The server's default: upstream's answer, or a minimal success without an upstream. */
  | { readonly _tag: "Default" }

export const hang: Reply = { _tag: "Hang" }
export const applyAndHang: Reply = { _tag: "ApplyAndHang" }
export const reset: Reply = { _tag: "Reset" }
export const passThrough: Reply = { _tag: "Default" }
export const answer = (status: number, body: string): Reply => ({ _tag: "Answer", status, body })
/** A DynamoDB error reply, as the SDK reads one. */
export const awsFailure = (status: number, name: string, message = name): Reply =>
  answer(status, JSON.stringify({ __type: `com.amazonaws.dynamodb.v20120810#${name}`, message }))

export interface SeenRequest {
  /** 1-based, across the server. */
  readonly number: number
  /** `GetItem`, from `x-amz-target`. */
  readonly operation: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
  /** The connection it arrived on has ended. */
  connectionClosed: boolean
  /** The server answered it. */
  answered: boolean
  /** Upstream answered it, so a write it carried has been applied (or refused). */
  reachedUpstream: boolean
}

export interface LocalServer {
  readonly endpoint: string
  /** In arrival order, once fully received. */
  readonly requests: ReadonlyArray<SeenRequest>
  /** Connections accepted so far. An attempt on a new connection adds one. */
  readonly connections: () => number
  /** Requests of an operation so far. */
  readonly of: (operation: string) => ReadonlyArray<SeenRequest>
  /** Wait until `reached` holds. */
  readonly until: (reached: () => boolean) => Effect.Effect<void>
  /** Deliver a request held by {@link hang} upstream now, and report what upstream said. */
  readonly land: (
    request: SeenRequest,
  ) => Effect.Effect<{ readonly status: number; readonly body: string }>
}

const minimalSuccess = (operation: string): string =>
  operation === "Query" || operation === "Scan"
    ? '{"Items":[],"Count":0,"ScannedCount":0}'
    : operation === "BatchGetItem"
      ? '{"Responses":{}}'
      : "{}"

export const localServer = (
  reply: (request: SeenRequest) => Reply = () => passThrough,
  options?: { readonly upstream?: string | undefined },
): Effect.Effect<LocalServer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const requests: Array<SeenRequest> = []
    const waiters = new Set<() => void>()
    const changed = () => {
      for (const check of [...waiters]) check()
    }
    let connections = 0
    const upstream = options?.upstream === undefined ? undefined : new URL(options.upstream)

    const sendUpstream = (seen: SeenRequest) =>
      new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>(
        (resolve, reject) => {
          if (upstream === undefined) {
            reject(new Error("this server has no upstream"))
            return
          }
          const outgoing = httpRequest(
            {
              host: upstream.hostname,
              port: upstream.port,
              method: "POST",
              path: "/",
              headers: seen.headers,
            },
            (incoming) => {
              const chunks: Array<Buffer> = []
              incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
              incoming.on("end", () => {
                seen.reachedUpstream = true
                resolve({
                  status: incoming.statusCode ?? 500,
                  body: Buffer.concat(chunks).toString(),
                  headers: incoming.headers,
                })
              })
            },
          )
          outgoing.on("error", reject)
          outgoing.end(seen.body)
        },
      )

    const respond = (
      seen: SeenRequest,
      response: ServerResponse,
      status: number,
      body: string,
      headers: IncomingHttpHeaders = { "content-type": "application/x-amz-json-1.0" },
    ) => {
      if (seen.connectionClosed) return
      seen.answered = true
      response.writeHead(status, headers)
      response.end(body)
      changed()
    }

    const server = createServer((incoming, response) => {
      const chunks: Array<Buffer> = []
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk))
      incoming.on("end", () => {
        const seen: SeenRequest = {
          number: requests.length + 1,
          operation: String(incoming.headers["x-amz-target"]).split(".")[1] ?? "",
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString(),
          connectionClosed: false,
          answered: false,
          reachedUpstream: false,
        }
        const socket: Socket = incoming.socket
        const closed = () => {
          seen.connectionClosed = true
          changed()
        }
        if (socket.destroyed) seen.connectionClosed = true
        else socket.once("close", closed)
        requests.push(seen)
        changed()
        const decided = reply(seen)
        switch (decided._tag) {
          case "Hang":
            return
          case "ApplyAndHang":
            void sendUpstream(seen).then(changed, changed)
            return
          case "Reset":
            socket.destroy()
            return
          case "Answer":
            respond(seen, response, decided.status, decided.body)
            return
          case "Default":
            if (upstream === undefined) {
              respond(seen, response, 200, minimalSuccess(seen.operation))
              return
            }
            void sendUpstream(seen).then(
              ({ status, body, headers }) => respond(seen, response, status, body, headers),
              () => response.destroy(),
            )
        }
      })
    })
    server.on("connection", () => {
      connections++
      changed()
    })

    yield* Effect.acquireRelease(
      Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
      () =>
        Effect.sync(() => {
          server.closeAllConnections()
          server.close()
        }),
    )
    const { port } = server.address() as AddressInfo

    return {
      endpoint: `http://127.0.0.1:${port}`,
      requests,
      connections: () => connections,
      of: (operation) => requests.filter((seen) => seen.operation === operation),
      until: (reached) =>
        Effect.callback<void>((resume) => {
          if (reached()) {
            resume(Effect.void)
            return
          }
          const check = () => {
            if (!reached()) return
            waiters.delete(check)
            resume(Effect.void)
          }
          waiters.add(check)
          return Effect.sync(() => waiters.delete(check))
        }),
      land: (seen) =>
        Effect.promise(() =>
          sendUpstream(seen).then(({ status, body }) => {
            changed()
            return { status, body }
          }),
        ),
    } satisfies LocalServer
  })
