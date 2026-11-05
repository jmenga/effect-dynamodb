import { createServer, type RequestListener, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { inspect } from "node:util"
import { DynamoDBServiceException } from "@aws-sdk/client-dynamodb"
import { DynamoDBStreamsServiceException } from "@aws-sdk/client-dynamodb-streams"
import { describe, expect, it } from "@effect/vitest"
import * as DynamoSchema from "@effect-dynamodb/schema/DynamoSchema.js"
import { Cause, Effect, Formatter, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { Otlp } from "effect/observability"
import * as ConsumedCapacity from "../src/ConsumedCapacity.js"
import {
  classifyStreamsError,
  DynamoStreamsClient,
} from "../src/change-feed/DynamoStreamsClient.js"
import { classifyError, DynamoClient } from "../src/DynamoClient.js"
import * as Entity from "../src/Entity.js"
import { REDACTED_REPLY, redactCredentialRefusal } from "../src/internal/CredentialRefusal.js"
import * as Table from "../src/Table.js"

const SESSION_TOKEN = "SENTINEL-SESSION-TOKEN"
const REQUEST_ID = "REQUEST-186"
const QUOTED_REQUEST = (token: unknown) =>
  `The Canonical String for this request should have been\n'POST\n/\n\nx-amz-security-token:${token}\n\n'`

const CREDENTIAL_REFUSALS = [
  "InvalidSignatureException",
  "SignatureDoesNotMatch",
  "IncompleteSignatureException",
  "MissingAuthenticationTokenException",
  "UnrecognizedClientException",
  "InvalidClientTokenId",
  "ExpiredTokenException",
  "ExpiredToken",
  "RequestExpired",
]

type SdkError = Error & {
  readonly $fault?: string
  readonly $metadata?: {
    readonly httpStatusCode?: number
    readonly requestId?: string
  }
}

const sdkError = (name: string, message: string, fields?: object): SdkError =>
  Object.assign(new Error(message), {
    name,
    $fault: "client",
    $metadata: { httpStatusCode: 400, requestId: REQUEST_ID },
    ...fields,
  })

/** Everywhere an application can turn an error into text. */
const renderings = (error: unknown): ReadonlyArray<string> => [
  String(error),
  JSON.stringify(error),
  inspect(error, { depth: 8 }),
  inspect(error, { showHidden: true, depth: 8 }),
  Formatter.format(error),
  Cause.pretty(Cause.fail(error)),
]

describe("redactCredentialRefusal", () => {
  it.each(CREDENTIAL_REFUSALS)("%s loses its reply and keeps what identifies it", (name) => {
    const original = sdkError(name, QUOTED_REQUEST(SESSION_TOKEN))
    const redacted = redactCredentialRefusal(original) as SdkError
    expect(redacted).not.toBe(original)
    expect(redacted.name).toBe(name)
    expect(redacted.message).toBe(REDACTED_REPLY)
    expect(redacted.stack).toBe(`${name}: ${REDACTED_REPLY}`)
    expect(redacted.$fault).toBe("client")
    expect(redacted.$metadata).toEqual({ httpStatusCode: 400, requestId: REQUEST_ID })
    for (const text of renderings(redacted)) expect(text).not.toContain(SESSION_TOKEN)
  })

  it("redacts a refusal whose reply happens not to quote anything", () => {
    const redacted = redactCredentialRefusal(sdkError("ExpiredToken", "The token expired"))
    expect((redacted as Error).message).toBe(REDACTED_REPLY)
  })

  it("keeps the SDK error's prototype, so instanceof still works", () => {
    class ServiceError extends Error {}
    const original = Object.assign(new ServiceError("refused"), {
      name: "InvalidSignatureException",
    })
    const redacted = redactCredentialRefusal(original)
    expect(redacted).toBeInstanceOf(ServiceError)
    expect(redacted).toBeInstanceOf(Error)
  })

  it("carries nothing else over, hidden or not", () => {
    const original = sdkError("SignatureDoesNotMatch", "refused", {
      __type: "SignatureDoesNotMatch",
      CanonicalRequest: QUOTED_REQUEST(SESSION_TOKEN),
    })
    Object.defineProperty(original, "$response", {
      value: { headers: { "x-amz-security-token": SESSION_TOKEN } },
      enumerable: false,
    })
    expect(Object.getOwnPropertyNames(redactCredentialRefusal(original)).sort()).toEqual([
      "$fault",
      "$metadata",
      "message",
      "name",
      "stack",
    ])
  })

  describe("an unlisted error that quotes the session token", () => {
    const quoting = {
      "in its message": sdkError("SomeNewRefusal", QUOTED_REQUEST(SESSION_TOKEN)),
      "in another field": sdkError("SomeNewRefusal", "refused", {
        CanonicalRequest: QUOTED_REQUEST(SESSION_TOKEN),
      }),
      "in its stack only": Object.assign(sdkError("SomeNewRefusal", "refused"), {
        stack: `SomeNewRefusal: ${QUOTED_REQUEST(SESSION_TOKEN)}`,
      }),
      "in another case": sdkError("SomeNewRefusal", `X-Amz-Security-Token: ${SESSION_TOKEN}`),
    }
    it.each(Object.entries(quoting))("is redacted when it is %s", (_, original) => {
      const redacted = redactCredentialRefusal(original) as SdkError
      expect(redacted.message).toBe(REDACTED_REPLY)
      expect(redacted.name).toBe("SomeNewRefusal")
      for (const text of renderings(redacted)) expect(text).not.toContain(SESSION_TOKEN)
    })

    it("is redacted when it has no name", () => {
      const redacted = redactCredentialRefusal({ message: QUOTED_REQUEST(SESSION_TOKEN) })
      expect((redacted as Error).name).toBe("Error")
      expect((redacted as Error).message).toBe(REDACTED_REPLY)
    })
  })

  describe("every other error is kept whole", () => {
    it.each([
      // `WriteDiagnosis` reads these refusals' wording.
      "ValidationException",
      "LimitExceededException",
      "TransactionCanceledException",
      // The credentials were accepted, and the wording names the principal and action.
      "AccessDeniedException",
      "ConditionalCheckFailedException",
      "ThrottlingException",
      "InternalServerError",
    ])("%s", (name) => {
      const original = sdkError(name, "wording someone reads")
      expect(redactCredentialRefusal(original)).toBe(original)
    })

    it("including a refusal that only names an attribute like a canonical request", () => {
      const original = sdkError(
        "ValidationException",
        "Invalid UpdateExpression: an attribute named canonicalRequest is not allowed",
      )
      expect(redactCredentialRefusal(original)).toBe(original)
    })

    it.each([[null], [undefined], ["text"], [1]])("and a non-object: %s", (value) => {
      expect(redactCredentialRefusal(value)).toBe(value)
    })
  })
})

describe.each<
  readonly [string, (thrown: unknown) => { readonly _tag: string; readonly cause?: unknown }]
>([
  ["classifyError", classifyError("PutItem")],
  ["classifyStreamsError", classifyStreamsError("GetRecords")],
])("%s", (_, classify) => {
  it("keeps only the redacted error as the cause of a refusal", () => {
    const error = classify(sdkError("InvalidSignatureException", QUOTED_REQUEST(SESSION_TOKEN)))
    expect(error._tag).toBe("DynamoError")
    expect((error.cause as Error).name).toBe("InvalidSignatureException")
    expect((error.cause as Error).message).toBe(REDACTED_REPLY)
    for (const text of renderings(error)) expect(text).not.toContain(SESSION_TOKEN)
  })

  it.each([
    ["ThrottlingException", "ThrottlingError"],
    ["ValidationException", "DynamoValidationError"],
    ["InternalServerError", "InternalServerError"],
    ["ResourceNotFoundException", "ResourceNotFoundError"],
  ])("still classifies %s as %s by name once redacted", (name, tag) => {
    const error = classify(sdkError(name, QUOTED_REQUEST(SESSION_TOKEN)))
    expect(error._tag).toBe(tag)
    expect((error.cause as Error).message).toBe(REDACTED_REPLY)
  })

  it("keeps any other error as the cause, untouched", () => {
    const original = sdkError("AccessDeniedException", "User is not authorized")
    expect(classify(original).cause).toBe(original)
  })
})

// ---------------------------------------------------------------------------
// The real SDK against a fake AWS endpoint, reported through the real OTLP
// exporter to a fake collector. DynamoDB Local can't stand in: it doesn't check
// signatures.
// ---------------------------------------------------------------------------

/**
 * `credentials` declares no session token, but the SDK reads the object as
 * given. Assigned through a variable because the literal wouldn't type-check.
 */
const credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "not-a-real-secret",
  sessionToken: SESSION_TOKEN,
}

const listen = (handler: RequestListener) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer(handler)
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.closeAllConnections()
        server.close(() => resume(Effect.void))
      }),
  )

const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`

type Reply = { readonly type: string; readonly quoteToken: boolean }

/** Refuses every request as AWS would, quoting the token the request carried if asked to. */
const refusingEndpoint = (reply: Reply) =>
  Effect.gen(function* () {
    const tokens: Array<unknown> = []
    const server = yield* listen((req, res) => {
      req.resume()
      req.on("end", () => {
        const token = req.headers["x-amz-security-token"]
        tokens.push(token)
        res.writeHead(400, {
          "content-type": "application/x-amz-json-1.0",
          "x-amzn-requestid": REQUEST_ID,
        })
        res.end(
          JSON.stringify({
            __type: `com.amazon.coral.service#${reply.type}`,
            message: reply.quoteToken ? QUOTED_REQUEST(token) : "A refusal that quotes nothing",
          }),
        )
      })
    })
    return { url: urlOf(server), tokens }
  })

const otlpCollector = Effect.gen(function* () {
  const traces: Array<string> = []
  const logs: Array<string> = []
  const server = yield* listen((req, res) => {
    const chunks: Array<Buffer> = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      if (req.url?.endsWith("/v1/traces")) traces.push(body)
      if (req.url?.endsWith("/v1/logs")) logs.push(body)
      res.writeHead(200, { "content-type": "application/json" })
      res.end("{}")
    })
  })
  return { url: urlOf(server), traces, logs }
})

type ExportedSpan = {
  readonly name: string
  readonly events?: ReadonlyArray<{
    readonly name: string
    readonly attributes?: ReadonlyArray<{
      readonly key: string
      readonly value: { readonly stringValue?: string }
    }>
  }>
}

const spansOf = (body: string): ReadonlyArray<ExportedSpan> =>
  (
    JSON.parse(body) as {
      readonly resourceSpans: ReadonlyArray<{
        readonly scopeSpans: ReadonlyArray<{ readonly spans: ReadonlyArray<ExportedSpan> }>
      }>
    }
  ).resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))

const stacktraceOf = (span: ExportedSpan | undefined): string | undefined =>
  span?.events
    ?.find((event) => event.name === "exception")
    ?.attributes?.find((attribute) => attribute.key === "exception.stacktrace")?.value.stringValue

class User extends Schema.Class<User>("User")({ userId: Schema.String, name: Schema.String }) {}

const Users = Entity.make({
  model: User,
  entityType: "User",
  primaryKey: { pk: { field: "pk", composite: ["userId"] }, sk: { field: "sk", composite: [] } },
})

const MainTable = Table.make({
  schema: DynamoSchema.make({ name: "credential-refusal", version: 1 }),
  entities: { Users },
})

const put = Effect.gen(function* () {
  const db = yield* DynamoClient.make({ entities: { Users }, tables: { MainTable } })
  yield* db.entities.Users.put({ userId: "u1", name: "n" })
})

/** What an application does with a failing operation. */
type Observed = <E, R>(operation: Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>

/** The SDK error at the bottom of an error's cause chain. */
const rootOf = (error: unknown): unknown => {
  const cause = (error as { readonly cause?: unknown } | undefined)?.cause
  return typeof cause === "object" && cause !== null ? rootOf(cause) : error
}

const observe = (reply: Reply, observed: Observed) =>
  Effect.scoped(
    Effect.gen(function* () {
      const endpoint = yield* refusingEndpoint(reply)
      const collector = yield* otlpCollector
      const error = yield* observed(put).pipe(
        Effect.provide(
          Layer.mergeAll(
            DynamoClient.layer({ region: "us-east-1", endpoint: endpoint.url, credentials }),
            MainTable.layer({ name: "t" }),
            ConsumedCapacity.layer(),
          ),
        ),
        // Closing this layer flushes the exporter, so the collector has it all below.
        Effect.provide(
          Otlp.layerJson({
            baseUrl: collector.url,
            resource: { serviceName: "credential-refusal-test" },
            loggerMergeWithExisting: false,
          }).pipe(Layer.provide(FetchHttpClient.layer)),
        ),
        Effect.flip,
      )
      return {
        error,
        sentTokens: endpoint.tokens,
        spans: collector.traces.flatMap(spansOf),
        traces: collector.traces.join("\n"),
        logs: collector.logs.join("\n"),
      }
    }),
  )

const inASpan: Observed = (operation) => operation.pipe(Effect.withSpan("app.outer"))

describe("a reply that quotes the session token, through the real SDK", () => {
  it.live("reaches no error rendering, trace or log from the DynamoDB client", () =>
    Effect.gen(function* () {
      const { error, sentTokens, spans, traces, logs } = yield* observe(
        { type: "InvalidSignatureException", quoteToken: true },
        (operation) =>
          operation.pipe(
            Effect.tapError((failure) => Effect.annotateCurrentSpan("app.error", failure)),
            Effect.tapError((failure) => Effect.annotateCurrentSpan("app.cause", rootOf(failure))),
            Effect.tapError((failure) => Effect.logError("failed", failure)),
            Effect.tapCause((cause) => Effect.logError(cause)),
            inASpan,
          ),
      )

      // Not vacuous: the SDK sent the token, and the reply quoted it back.
      expect(sentTokens).toEqual([SESSION_TOKEN])

      expect((error as { readonly _tag: string })._tag).toBe("DynamoError")
      const cause = rootOf(error) as SdkError
      expect(cause).toBeInstanceOf(DynamoDBServiceException)
      expect(cause.name).toBe("InvalidSignatureException")
      expect(cause.message).toBe(REDACTED_REPLY)
      expect(cause.$fault).toBe("client")
      expect(cause.$metadata?.httpStatusCode).toBe(400)
      expect(cause.$metadata?.requestId).toBe(REQUEST_ID)
      for (const text of renderings(error)) expect(text).not.toContain(SESSION_TOKEN)

      // Every failed span reports it, with or without capacity reporting's own span.
      expect(spans.map((span) => span.name).sort()).toEqual([
        "app.outer",
        "effect-dynamodb.Entity.put",
      ])
      for (const span of spans) expect(stacktraceOf(span)).toContain("InvalidSignatureException")
      expect(traces).not.toContain(SESSION_TOKEN)

      expect(logs).toContain("InvalidSignatureException")
      expect(logs).not.toContain(SESSION_TOKEN)
    }),
  )

  it.live("reaches no error rendering from the DynamoDB Streams client", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const endpoint = yield* refusingEndpoint({
          type: "InvalidSignatureException",
          quoteToken: true,
        })
        const error = yield* Effect.gen(function* () {
          const client = yield* DynamoStreamsClient
          yield* client.getRecords({ ShardIterator: "iterator" })
        }).pipe(
          Effect.provide(
            DynamoStreamsClient.layer({
              region: "us-east-1",
              endpoint: endpoint.url,
              credentials,
            }),
          ),
          Effect.flip,
        )

        expect(endpoint.tokens).toEqual([SESSION_TOKEN])
        expect(error._tag).toBe("DynamoError")
        const cause = rootOf(error) as SdkError
        expect(cause).toBeInstanceOf(DynamoDBStreamsServiceException)
        expect(cause.name).toBe("InvalidSignatureException")
        expect(cause.message).toBe(REDACTED_REPLY)
        expect(cause.$metadata?.requestId).toBe(REQUEST_ID)
        for (const text of renderings(error)) expect(text).not.toContain(SESSION_TOKEN)
      }),
    ),
  )
})

// ---------------------------------------------------------------------------
// Errors that keep the SDK's error keep its non-enumerable `$response` too, and
// that reaches the request's headers, session token and `Authorization` included
// (`$response.body.req`). It is left in place because no exporter sends it: these
// tests fail if an Effect or SDK upgrade changes that.
// ---------------------------------------------------------------------------
describe("the SDK's $response on an error that keeps its wording", () => {
  const applicationHandling: Readonly<Record<string, Observed>> = {
    "the span only fails": inASpan,
    "the application annotates the span with the tagged error": (operation) =>
      operation.pipe(
        Effect.tapError((failure) => Effect.annotateCurrentSpan("app.error", failure)),
        inASpan,
      ),
    "the application annotates the span with the SDK error": (operation) =>
      operation.pipe(
        Effect.tapError((failure) => Effect.annotateCurrentSpan("app.cause", rootOf(failure))),
        inASpan,
      ),
    "the application annotates the span with an object holding the SDK error": (operation) =>
      operation.pipe(
        Effect.tapError((failure) =>
          Effect.annotateCurrentSpan("app.wrapped", { cause: rootOf(failure) }),
        ),
        inASpan,
      ),
    "the application logs the error": (operation) =>
      operation.pipe(
        Effect.tapError((failure) => Effect.logError("failed", failure)),
        inASpan,
      ),
    "the application logs the cause": (operation) =>
      operation.pipe(
        Effect.tapCause((cause) => Effect.logError(cause)),
        inASpan,
      ),
  }

  describe.each([
    "ConditionalCheckFailedException",
    "ValidationException",
    "AccessDeniedException",
  ])("%s", (type) => {
    it.live("keeps its wording", () =>
      Effect.gen(function* () {
        const { error } = yield* observe({ type, quoteToken: false }, inASpan)
        const cause = rootOf(error) as SdkError
        expect(cause.name).toBe(type)
        expect(cause.message).toBe("A refusal that quotes nothing")
      }),
    )

    for (const [handling, observed] of Object.entries(applicationHandling)) {
      it.live(`isn't exported when ${handling}`, () =>
        Effect.gen(function* () {
          const { error, sentTokens, spans, traces, logs } = yield* observe(
            { type, quoteToken: false },
            observed,
          )
          // Not vacuous: the token was sent, the error holds $response, spans were exported.
          expect(sentTokens).toEqual([SESSION_TOKEN])
          expect(Object.getOwnPropertyDescriptor(rootOf(error), "$response")).toBeDefined()
          expect(spans.map((span) => span.name)).toContain("app.outer")

          expect(traces).not.toContain(SESSION_TOKEN)
          expect(traces).not.toContain("AWS4-HMAC-SHA256")
          expect(logs).not.toContain(SESSION_TOKEN)
          expect(logs).not.toContain("AWS4-HMAC-SHA256")
        }),
      )
    }
  })

  // The control: these tests can see a leak, and `$response` does hold the token.
  // If an SDK upgrade fails only this test, `$response` stopped reaching the
  // request's headers, and the tests above no longer guard anything.
  it.live("is exported only if the application puts $response on a span itself", () =>
    Effect.gen(function* () {
      const { traces } = yield* observe(
        { type: "ValidationException", quoteToken: false },
        (operation) =>
          operation.pipe(
            Effect.tapError((failure) =>
              Effect.annotateCurrentSpan(
                "app.response",
                (rootOf(failure) as { readonly $response?: unknown }).$response,
              ),
            ),
            inASpan,
          ),
      )
      expect(traces).toContain(SESSION_TOKEN)
      expect(traces).toContain("AWS4-HMAC-SHA256")
    }),
  )
})
