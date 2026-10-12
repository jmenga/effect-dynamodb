/**
 * `nearby`'s error channel is the 1.25.0 one (#147): packed storage never
 * widens it — a missing compressor is a `ValidationError` whose `cause` is a
 * `CompressorNotRegistered`.
 *
 * Compile-time only; checked by `tsc -p tsconfig.test.json` (`pnpm check`).
 */

import type { Effect } from "effect"
import type { DynamoClientError, ValidationError } from "effect-dynamodb"
import { describe, expect, expectTypeOf, it } from "vitest"
import type * as GeoIndex from "../src/GeoIndex.js"
import type * as GeoSearch from "../src/GeoSearch.js"

describe("GeoIndex error channels", () => {
  it("nearby fails with DynamoClientError | ValidationError, bound or not", () => {
    type Unbound = ReturnType<GeoIndex.GeoIndex<unknown, unknown>["nearby"]>
    type Bound = ReturnType<GeoIndex.BoundGeoIndex<unknown>["nearby"]>
    type Search = ReturnType<typeof GeoSearch.nearby<unknown>>
    expectTypeOf<Effect.Error<Unbound>>().toEqualTypeOf<DynamoClientError | ValidationError>()
    expectTypeOf<Effect.Error<Bound>>().toEqualTypeOf<DynamoClientError | ValidationError>()
    expectTypeOf<Effect.Error<Search>>().toEqualTypeOf<DynamoClientError | ValidationError>()
    expect(true).toBe(true)
  })
})
