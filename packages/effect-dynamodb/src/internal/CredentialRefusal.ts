/**
 * Keeps AWS's reply to a signature or credential refusal out of errors (#186).
 *
 * AWS answers a request whose signature it can't match with a message that can
 * quote the canonical request: the signed headers' values, including
 * `x-amz-security-token`, the caller's session token. A tagged error keeps what
 * the SDK threw as its `cause`, and tracers, loggers and `JSON.stringify` all
 * render a cause's message, so that reply can't stay on it.
 *
 * Every SDK classifier runs what it catches through
 * {@link redactCredentialRefusal} first. Nothing reads these replies' wording:
 * classification reads `name`, and `WriteDiagnosis.ts` only reads request-shape
 * refusals, which keep theirs.
 *
 * @internal
 */

/**
 * AWS's names for a refused signature or credential. `AccessDeniedException` is
 * not one of them: the credentials were accepted, and its wording names the
 * principal and the action, which is what its reader needs.
 */
const CREDENTIAL_REFUSALS: ReadonlySet<string> = new Set([
  // The signature
  "InvalidSignatureException",
  "SignatureDoesNotMatch",
  "IncompleteSignatureException",
  // The credentials
  "MissingAuthenticationTokenException",
  "UnrecognizedClientException",
  "InvalidClientTokenId",
  // Their age
  "ExpiredTokenException",
  "ExpiredToken",
  "RequestExpired",
])

/**
 * The secret in a quoted request is this header's value. Matching the header
 * rather than the words "canonical request" keeps a request-shape refusal that
 * merely names an attribute such as `canonicalString`, whose wording
 * `WriteDiagnosis.ts` reads.
 */
const SESSION_TOKEN_HEADER = /x-amz-security-token/i

/** The `message` of a redacted error. */
export const REDACTED_REPLY =
  "AWS's reply was removed because it can quote the signed request, including the session token. " +
  "The request id is in $metadata.requestId."

/**
 * Catches a reply under a name {@link CREDENTIAL_REFUSALS} doesn't list. Service
 * errors also carry the reply's other fields, S3's `CanonicalRequest` among them.
 */
const quotesSessionToken = (cause: object): boolean => {
  const { message, stack } = cause as { readonly message?: unknown; readonly stack?: unknown }
  return [message, stack, ...Object.values(cause)].some(
    (text) => typeof text === "string" && SESSION_TOKEN_HEADER.test(text),
  )
}

/**
 * What a tagged error may keep of what the SDK threw: `cause` itself, unless it
 * is a signature or credential refusal or quotes the session token.
 *
 * Those become a new error with fixed text, keeping only `name`, `$fault`,
 * `$metadata` and the prototype, so classification, `instanceof` and
 * troubleshooting by request id still work. It is a new error rather than the
 * SDK's edited in place because the SDK's `$response` can't be removed, and
 * reaches the request's headers.
 *
 * @internal
 */
export const redactCredentialRefusal = (cause: unknown): unknown => {
  if (cause === null || typeof cause !== "object") return cause
  const { name, $fault, $metadata } = cause as {
    readonly name?: unknown
    readonly $fault?: unknown
    readonly $metadata?: unknown
  }
  const refused = typeof name === "string" && CREDENTIAL_REFUSALS.has(name)
  if (!refused && !quotesSessionToken(cause)) return cause
  const label = typeof name === "string" ? name : "Error"
  const redacted = new Error(REDACTED_REPLY)
  Object.setPrototypeOf(redacted, Object.getPrototypeOf(cause))
  redacted.name = label
  redacted.stack = `${label}: ${REDACTED_REPLY}`
  return Object.assign(redacted, { $fault, $metadata })
}
