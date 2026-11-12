/**
 * What the `DynamoClient` and `DynamoStreamsClient` layers share (#190): the SDK
 * client options they pass through, and the client's life inside a layer.
 *
 * None of these options has a default here, and nothing imports a platform
 * handler: a plain-object `requestHandler` goes to the SDK, whose build for the
 * runtime constructs its own handler from it (`NodeHttpHandler` on Node and Bun,
 * `FetchHttpHandler` in browsers and Workers).
 *
 * @internal
 */

import type { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb"
import { Config, Effect, Option, type Scope } from "effect"

/**
 * A client's `requestHandler`: an HTTP handler, or the options of the runtime's
 * handler. The SDK's own type also admits `Record<string, unknown>`, under which
 * a misspelt `socketTimout` would compile and leave the call with no timeout.
 */
export type RequestHandlerOption = Exclude<
  NonNullable<DynamoDBClientConfig["requestHandler"]>,
  Record<string, unknown>
>

/** An HTTP handler itself, as opposed to the options of one. */
export type RequestHandlerInstance = Extract<RequestHandlerOption, { readonly handle: unknown }>

/** The SDK client options a layer passes through. Unset ones stay the SDK's. */
export interface ClientOptions {
  /**
   * The HTTP handler, or the options of the runtime's handler: on Node and Bun
   * `connectionTimeout`, `socketTimeout`, `requestTimeout` (which only logs a
   * warning unless `throwOnRequestTimeout` is set) and agents; on fetch runtimes
   * `requestTimeout`. The SDK sets no timeout by default, so a connection that
   * stays open and never answers keeps the call waiting.
   */
  readonly requestHandler?: RequestHandlerOption | undefined
  /** Attempts per request, the first included. The SDK's default is 3. */
  readonly maxAttempts?: number | undefined
}

/**
 * Static credentials for a layer. `sessionToken` is the third part of temporary
 * credentials (an assumed role, STS), which the SDK sends as
 * `x-amz-security-token`. Nothing in the library reads them: the SDK client gets
 * them, and AWS's reply to a refused signature, which can quote the token, is
 * redacted (`internal/CredentialRefusal.ts`).
 */
export type Credentials = {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string | undefined
}

/**
 * {@link Credentials} as the SDK client takes them: a token left `undefined` is
 * left out, since the SDK's type has none for `undefined`. Anything else is
 * passed as given.
 */
export const sdkCredentials = (credentials: Credentials) => {
  const { sessionToken, ...rest } = credentials
  return sessionToken === undefined ? rest : { ...rest, sessionToken }
}

/**
 * The handler's options an operator tunes per environment, each read through
 * `Config`. One that is missing stays unset; one that doesn't parse fails the
 * layer with its `ConfigError`.
 */
export interface RequestTimeoutsFromConfig {
  readonly connectionTimeout?: Config.Config<number> | undefined
  readonly socketTimeout?: Config.Config<number> | undefined
  readonly requestTimeout?: Config.Config<number> | undefined
  readonly throwOnRequestTimeout?: Config.Config<boolean> | undefined
}

/**
 * {@link ClientOptions} for a `layerConfig`. The scalars are values a config
 * provider can hold. A handler instance is code, with agents and loggers inside
 * it, so it is passed as itself, as `compressors` is.
 */
export interface ClientOptionsFromConfig {
  readonly requestHandler?: RequestTimeoutsFromConfig | RequestHandlerInstance | undefined
  readonly maxAttempts?: Config.Config<number> | undefined
}

const isInstance = (
  handler: RequestTimeoutsFromConfig | RequestHandlerInstance,
): handler is RequestHandlerInstance =>
  typeof (handler as { readonly handle?: unknown }).handle === "function"

/** A value that may be missing from the provider: `undefined` then. */
const optional = <A>(
  config: Config.Config<A> | undefined,
): Effect.Effect<A | undefined, Config.ConfigError> =>
  Effect.gen(function* () {
    return config === undefined ? undefined : Option.getOrUndefined(yield* Config.option(config))
  })

const TIMEOUTS = [
  "connectionTimeout",
  "socketTimeout",
  "requestTimeout",
  "throwOnRequestTimeout",
] as const

/** Read a `layerConfig`'s {@link ClientOptionsFromConfig}. */
export const readClientOptions = (
  config: ClientOptionsFromConfig,
): Effect.Effect<ClientOptions, Config.ConfigError> =>
  Effect.gen(function* () {
    const maxAttempts = yield* optional(config.maxAttempts)
    const handler = config.requestHandler
    let requestHandler: RequestHandlerOption | undefined
    if (handler !== undefined && isInstance(handler)) {
      requestHandler = handler
    } else if (handler !== undefined) {
      const read: Record<string, number | boolean> = {}
      for (const name of TIMEOUTS) {
        const value = yield* optional<number | boolean>(handler[name])
        if (value !== undefined) read[name] = value
      }
      if (Object.keys(read).length > 0) requestHandler = read
    }
    return {
      ...(requestHandler === undefined ? {} : { requestHandler }),
      ...(maxAttempts === undefined ? {} : { maxAttempts }),
    }
  })

/** What the SDK clients have in common, as far as {@link acquireSdkClient} needs it. */
type SdkClient = {
  readonly destroy: () => void
  readonly middlewareStack: {
    readonly add: (
      middleware: (
        next: (args: unknown) => Promise<unknown>,
      ) => (args: unknown) => Promise<unknown>,
      options: {
        readonly step: "finalizeRequest"
        readonly priority: "low"
        readonly name: string
      },
    ) => void
  }
}

/**
 * The SDK client of a layer: made when the layer is built, destroyed when its
 * scope closes.
 *
 * A fiber interrupted before then has already aborted its request. One that
 * outlives the scope has not, and destroying the client doesn't end its request:
 * it only closes the socket, which the SDK takes for a dropped connection and
 * retries on a new one, with no timeout unless one is configured, and a write
 * goes out again. So a request sent before the close makes no further attempt,
 * and fails with `ClientClosedError` instead. A request sent after the close
 * still goes out, as it always has: the client stays usable.
 */
export const acquireSdkClient = <C>(make: () => C): Effect.Effect<C, never, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(
      Effect.sync(() => {
        const client = make()
        const sdk = client as unknown as SdkClient
        let closed = false
        // Inside the retry middleware, so it sees each attempt. The outer function runs once
        // per `send`.
        sdk.middlewareStack.add(
          (next) => {
            const sentOpen = !closed
            return (args) => (closed && sentOpen ? Promise.reject(clientClosed()) : next(args))
          },
          { step: "finalizeRequest", priority: "low", name: "effectDynamodbClientClosed" },
        )
        return {
          client,
          close: () => {
            closed = true
            sdk.destroy()
          },
        }
      }),
      ({ close }) => Effect.sync(close),
    ),
    ({ client }) => client,
  )

const clientClosed = (): Error =>
  Object.assign(
    new Error(
      "The client's layer closed before this request could be retried. " +
        "A write it carried may still have been applied.",
    ),
    { name: "ClientClosedError" },
  )
