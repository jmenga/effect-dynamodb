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
import { Config, ConfigProvider, Effect, Exit, Option, type Scope } from "effect"

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
 * `x-amz-security-token`; `undefined` or `null` sends none. Nothing in the
 * library reads them: the SDK client gets them, and AWS's reply to a refused
 * signature, which can quote the token, is redacted
 * (`internal/CredentialRefusal.ts`).
 */
export type Credentials = {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string | null | undefined
}

/**
 * The caller's credentials, as the SDK client's configuration types them. The
 * object itself is passed, never a copy: the SDK reads it for every request, so
 * an object changed in place, keys held in getters, and a provider function an
 * untyped caller passes all keep working. Only the type differs: the SDK's has
 * no `undefined` or `null` token, and sends none for either.
 */
export const sdkCredentials = (
  credentials: Credentials,
): NonNullable<DynamoDBClientConfig["credentials"]> =>
  credentials as NonNullable<DynamoDBClientConfig["credentials"]>

type Loaded = Exit.Exit<ConfigProvider.Node | undefined, ConfigProvider.SourceError> | undefined

const PARTS = ["accessKeyId", "secretAccessKey", "sessionToken"] as const

/** Text as it is compared: a `Config` that trims or changes case still carries the value. */
const plain = (value: string): string => value.trim().toLowerCase()

/** The three parts of what a `Config` yielded, as compared. Never throws. */
const partsOf = (credentials: unknown): ReadonlyArray<string> =>
  PARTS.map((part) => {
    try {
      const value = (credentials as Record<string, unknown> | null | undefined)?.[part]
      return typeof value === "string" ? plain(value) : ""
    } catch {
      return ""
    }
  })

/** Letters and digits no `Config` can hold beforehand. */
const unguessable = (length: number): string => {
  let text = ""
  while (text.length < length) text += Math.random().toString(36).slice(2)
  return text.slice(0, length)
}

/** More values missing than this are not searched for what stands in for them. */
const MOST_MISSING = 6

/**
 * Read a `layerConfig`'s `credentials`: the credentials, or `undefined` when
 * none are configured, for the SDK's default credential chain.
 *
 * `Config.option` alone reads a group (`Config.all`) with any part missing as
 * absent, so a key given without its secret, or a key and secret beside a
 * token that isn't there, were dropped, and the request was signed by whatever
 * identity the default chain held. Credentials given in part now fail the layer
 * with the error the `Config` gives for what is missing.
 *
 * The source is read once, by the caller's `Config`, exactly as before. When
 * that comes back absent although the source gave a value, the `Config` is
 * evaluated again against the answers already given (never the source), to
 * prove that the credentials are given in part: that they are made of a value
 * the source holds and of values it doesn't.
 *
 * 1. One or two of the values that are missing are stood in for, each by
 *    text no `Config` can hold beforehand, as few as will do. The `Config`
 *    must then yield credentials, and every stand-in must be one of their
 *    three parts: what is missing is a part of the credentials, not a mode, a
 *    flag or another setting.
 * 2. A value the source did hold must be one of the parts too. With that
 *    value changed, again to text no `Config` can hold, the part must change
 *    with it and the other parts must stay as they were: it is a part of the
 *    credentials, not a selector.
 *
 * An evaluation that asks for anything the source wasn't asked for the first
 * time proves nothing: what the source holds there isn't known.
 *
 * With both proven the layer fails. Without, what was found can't be told from
 * a setting that isn't a credential, and the `Config` reads as absent, as it
 * always did. That is the case when the only values given select what to read
 * (`PROFILE=dev`) or are other settings; when what is missing is another
 * setting, alone or beside a part that is missing too; when a part reaches
 * the credentials as other text than was given
 * (beyond trimming and case), or the `Config` accepts it only in some form (a
 * literal, a pattern, a length the stand-in or the changed value doesn't meet);
 * when what is missing is a struct; when the `Config` stopped at what is
 * missing and would read on from there (`Config.flatMap`); and when it reads
 * the provider in context itself (in a `Config.mapEffect`).
 *
 * The `Config` is known only by what it yields. A value that is a part as
 * given, and is that part again once changed, is taken as that part, whatever
 * the `Config` makes of values it wasn't evaluated with.
 *
 * Those evaluations run only then, and run the `Config`'s own functions again
 * (`Config.mapEffect`, `Config.flatMap`), with the stand-in and changed values.
 *
 * An invalid value, or a provider that fails, fails the layer as before.
 */
export const readCredentials = (
  config: Config.Config<Credentials> | undefined,
): Effect.Effect<Credentials | undefined, Config.ConfigError> =>
  Effect.gen(function* () {
    // Anything that is no `Config` is none, as it was to an untyped caller.
    if (!config) return undefined
    const provider = yield* ConfigProvider.ConfigProvider
    // Every answer the source gave, by path and, for a path asked for more
    // than once, by which time it was asked. One never read has no answer.
    const loaded = new Map<string, Array<Loaded>>()
    const watched = ConfigProvider.make((path) => {
      const key = JSON.stringify(path)
      const answers = loaded.get(key) ?? []
      loaded.set(key, answers)
      const at = answers.length++
      return Effect.onExit(provider.load(path), (exit) =>
        Effect.sync(() => {
          answers[at] = exit
        }),
      )
    })
    // The provider in context stays the caller's: what the `Config` reads from
    // it by itself (in a `mapEffect`) is read as before, and not watched.
    const read = yield* Config.option(config).parse(watched)
    if (Option.isSome(read)) return read.value

    // Each value the source gave, by the ask it answered.
    const given: Array<{ readonly ask: string; readonly value: string }> = []
    // The paths the source held no value at.
    const missing: Array<string> = []
    for (const [path, answers] of loaded) {
      answers.forEach((answer, at) => {
        if (answer === undefined || Exit.isFailure(answer)) return
        const value = answer.value?.value
        if (value === undefined) {
          if (!missing.includes(path)) missing.push(path)
        } else if (plain(value) !== "") {
          given.push({ ask: `${path}#${at}`, value })
        }
      })
    }
    if (given.length === 0 || missing.length > MOST_MISSING) return undefined

    const standIns = new Map(missing.map((path) => [path, unguessable(40)]))
    const change = unguessable(16)
    /**
     * `read` against the answers again, each given to the ask it was given to
     * before. With `fill`, a stand-in at those paths; with `changed`, the value
     * given to that ask changed. `known` is false once anything is read that the
     * source gave no answer for: a path it wasn't asked for, one asked for but
     * not read, or the provider in context.
     */
    const again = <A>(read: Config.Config<A>, fill: ReadonlySet<string>, changed?: string) =>
      Effect.suspend(() => {
        const asked = new Map<string, number>()
        const stood: Array<string> = []
        let known = true
        const source = ConfigProvider.make((path) => {
          const key = JSON.stringify(path)
          const at = asked.get(key) ?? 0
          asked.set(key, at + 1)
          return Effect.suspend(() => {
            const answer = loaded.get(key)?.[at]
            if (answer === undefined) {
              known = false
              return Effect.succeed(undefined)
            }
            if (Exit.isFailure(answer)) return answer
            const node = answer.value
            if (node?.value !== undefined) {
              return `${key}#${at}` === changed
                ? Effect.succeed({ ...node, value: node.value + change })
                : answer
            }
            const standIn = fill.has(key) ? standIns.get(key) : undefined
            if (standIn === undefined) return answer
            stood.push(standIn)
            return Effect.succeed(ConfigProvider.makeValue(standIn))
          })
        })
        const unknown = ConfigProvider.make(() =>
          Effect.sync(() => {
            known = false
            return undefined
          }),
        )
        return read.parse(source).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, unknown),
          Effect.exit,
          Effect.map((exit) => ({ exit, known, stood })),
        )
      })
    /** The parts of the credentials the `Config` then yields, if it does, and whether every stand-in is one. */
    const complete = (fill: ReadonlySet<string>, changed?: string) =>
      Effect.map(again(Config.option(config), fill, changed), ({ exit, known, stood }) => {
        if (!known || Exit.isFailure(exit) || Option.isNone(exit.value)) return undefined
        const parts = partsOf(exit.value.value)
        return { parts, whole: stood.every((standIn) => parts.includes(standIn)) }
      })

    // As few stand-ins as will do: one, then two (a third part must be given).
    const fills = [
      ...missing.map((path) => new Set([path])),
      ...missing.flatMap((path, i) => missing.slice(i + 1).map((other) => new Set([path, other]))),
    ]
    const done: Array<ReadonlySet<string>> = []
    for (const fill of fills) {
      // One that holds a smaller one stands in for more than is missing.
      if (done.some((less) => [...less].every((path) => fill.has(path)))) continue
      const completed = yield* complete(fill)
      if (completed === undefined) continue
      done.push(fill)
      if (!completed.whole) continue
      for (const { ask, value } of given) {
        const part = plain(value)
        // Changed only if it is a part as given: other values aren't evaluated with.
        if (!completed.parts.includes(part)) continue
        const moved = yield* complete(fill, ask)
        const follows = plain(value + change)
        // That part follows the value and the other parts stay: a value that
        // changes those selects.
        if (
          moved?.parts.includes(follows) === true &&
          completed.parts.every(
            (before, at) =>
              moved.parts[at] === before || (before === part && moved.parts[at] === follows),
          )
        ) {
          // Fails with the error the `Config` gives for what is missing. A
          // `Config` that yields credentials this time proves nothing.
          const last = yield* again(config, new Set())
          return last.known && Exit.isFailure(last.exit)
            ? yield* Effect.failCause(last.exit.cause)
            : undefined
        }
      }
    }
    return undefined
  })

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
