/**
 * Embedder — the pluggable text→vector service used by the vector-search write
 * path.
 *
 * DynamoDB never computes or refreshes an embedding; producing one is entirely
 * the application's job. The library models that job as an Effect service so it
 * can be swapped per environment (a real model in production, a deterministic
 * stub in tests) without touching entity definitions.
 *
 * A Bedrock-backed implementation is documented as an example rather than
 * shipped — bundling one would drag the Bedrock Runtime client into every
 * consumer's runtime graph, and this package is AWS-free by contract.
 *
 * See `DESIGN.md §14 Vector Search`.
 */

import { Context, Effect, Layer } from "effect"
import { EmbeddingError } from "./Errors.js"

/**
 * Service interface for embedding generation.
 *
 * `dimensions` is declared rather than inferred so `DynamoClient.make` can
 * validate agreement with every bound vector index at construction time — a
 * mismatch then fails once, at wiring, instead of on the thousandth write.
 */
export interface EmbedderService {
  /** Produce an embedding for the given text. */
  readonly embed: (text: string) => Effect.Effect<ReadonlyArray<number>, EmbeddingError>
  /** Dimensionality of every vector this embedder produces. */
  readonly dimensions: number
}

/**
 * Effect `Context.Service` tag for the embedding generator.
 *
 * Provide it in the environment (or pass `embedder` to `DynamoClient.make`) for
 * any entity that declares `vectorIndexes`. Bound entity operations resolve it
 * from the captured context, so they stay `R = never`.
 *
 * @example
 * ```typescript
 * const program = Effect.gen(function* () {
 *   const db = yield* DynamoClient.make({ entities: { Products }, tables: { MainTable } })
 *   yield* db.entities.Products.put(input)
 * }).pipe(Effect.provide(Embedder.layerTest({ dimensions: 8 })))
 * ```
 */
export class Embedder extends Context.Service<Embedder, EmbedderService>()(
  "@effect-dynamodb/Embedder",
) {
  /**
   * A deterministic, dependency-free embedder for tests, examples, and the
   * connected suite.
   *
   * The same text always produces the same unit vector, and lexically similar
   * text produces nearby vectors — enough structure to make ranking assertions
   * meaningful without calling a real model. NOT suitable for production
   * semantic search.
   */
  static readonly layerTest = (config: { readonly dimensions: number }): Layer.Layer<Embedder> =>
    Layer.succeed(Embedder, makeTestEmbedder(config.dimensions))

  /**
   * Build an {@link EmbedderService} from a plain (possibly async) function.
   * Failures are wrapped as {@link EmbeddingError}.
   */
  static readonly fromEffect = (config: {
    readonly dimensions: number
    readonly embed: (text: string) => Effect.Effect<ReadonlyArray<number>, unknown>
  }): EmbedderService => ({
    dimensions: config.dimensions,
    embed: (text) =>
      config.embed(text).pipe(
        Effect.mapError(
          (cause) =>
            new EmbeddingError({
              entityType: "<unknown>",
              index: "<unknown>",
              reason: "Embedder.embed failed",
              cause,
            }),
        ),
      ),
  })
}

/**
 * @internal Deterministic hash-based embedder. Each token contributes to a
 * fixed set of dimensions derived from its hash; the result is L2-normalized so
 * cosine and dot-product scores stay in a sane range.
 */
export const makeTestEmbedder = (dimensions: number): EmbedderService => ({
  dimensions,
  embed: (text: string) => Effect.succeed(hashEmbed(text, dimensions)),
})

/** @internal FNV-1a — small, fast, dependency-free, and stable across runs. */
const fnv1a = (value: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** @internal Token-hash bag-of-words embedding, L2-normalized. */
const hashEmbed = (text: string, dimensions: number): ReadonlyArray<number> => {
  const vector = new Array<number>(dimensions).fill(0)
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
  for (const token of tokens) {
    const hash = fnv1a(token)
    const slot = hash % dimensions
    // Sign derived from a second, independent hash so tokens do not all push in
    // the same direction (which would make every vector nearly parallel).
    const sign = fnv1a(`${token}#sign`) % 2 === 0 ? 1 : -1
    vector[slot] = (vector[slot] ?? 0) + sign
  }
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0))
  if (magnitude === 0) {
    // Empty/unhashable text — return a stable unit vector rather than zeros, so
    // cosine distance stays defined.
    const fallback = new Array<number>(dimensions).fill(0)
    fallback[0] = 1
    return fallback
  }
  return vector.map((v) => v / magnitude)
}
