/**
 * @internal Default `Crypto` service for the typed client.
 *
 * `DynamoClient.make()` bundles a default {@link Crypto.Crypto} service into the
 * captured context so that bound entity operations (e.g. auto-generated UUID
 * primary keys via `generatedId`) can resolve a cryptographically-secure source
 * WITHOUT widening the public `R` of bound methods. Bound `put` stays
 * `R = never` — the service is provided from the bundled context, never
 * surfaced as a requirement.
 *
 * The implementation is a thin wrapper over the global Web Crypto API
 * (`globalThis.crypto`), available on Node 18+ and all modern browsers/edge
 * runtimes — NO new dependency. Consumers needing a platform-specific source
 * (e.g. `@effect/platform-node`) may override it via
 * `DynamoClient.make({ crypto })`.
 */

import { Crypto, Effect, PlatformError } from "effect"

/**
 * Build the default `Crypto` service backed by `globalThis.crypto`.
 *
 * `randomBytes` uses `crypto.getRandomValues` (synchronous, CSPRNG). `digest`
 * delegates to `crypto.subtle.digest` — unused by the ORM today but required by
 * `Crypto.make`'s constructor contract.
 */
export const makeDefaultCrypto = (): Crypto.Crypto => {
  const webCrypto = globalThis.crypto
  return Crypto.make({
    // Crypto.make requires a fresh array per call (it mutates UUID bytes).
    randomBytes: (size) => webCrypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.tryPromise({
        try: () => webCrypto.subtle.digest(algorithm, data as unknown as ArrayBuffer),
        catch: (cause) =>
          PlatformError.badArgument({
            module: "Crypto",
            method: "digest",
            description: `digest failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          }),
      }).pipe(Effect.map((buf) => new Uint8Array(buf))),
  })
}
