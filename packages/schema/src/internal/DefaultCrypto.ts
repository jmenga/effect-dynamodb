/**
 * @internal Default `SecureRandom` service for the typed client.
 *
 * `DynamoClient.make()` bundles a default {@link SecureRandom.SecureRandom}
 * service into the captured context so that bound entity operations (e.g.
 * auto-generated UUID primary keys via `generatedId`) can resolve a
 * cryptographically-secure source WITHOUT widening the public `R` of bound
 * methods. Bound `put` stays `R = never` — the service is provided from the
 * bundled context, never surfaced as a requirement.
 *
 * The implementation is a thin wrapper over the global Web Crypto API
 * (`globalThis.crypto`), available on Node 19+ (Node 18 only with
 * `--experimental-global-webcrypto`) and all modern browsers/edge runtimes —
 * NO new dependency. Consumers needing a platform-specific source (e.g.
 * `@effect/platform-node`) may override it via `DynamoClient.make({ crypto })`.
 */

import { SecureRandom } from "effect/crypto"

/**
 * Build the default `SecureRandom` service backed by `globalThis.crypto`.
 *
 * `crypto.getRandomValues` is synchronous and a CSPRNG. Each service orders its
 * own UUIDv7s and ULIDs, so a client gets its own ordering.
 */
export const makeDefaultCrypto = (): SecureRandom.SecureRandom["Service"] => {
  const webCrypto = globalThis.crypto
  // SecureRandom.make requires a fresh array per call (it mutates UUID bytes).
  return SecureRandom.make((size) => webCrypto.getRandomValues(new Uint8Array(size)))
}
