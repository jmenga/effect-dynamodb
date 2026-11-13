/**
 * @internal A write's input in its stored form: the one decision of which form an input is in,
 * for every write that encodes one (`Entity`'s writes, and the put a transaction or a batch builds,
 * `TransactableOps.validateAndBuildPutItem`).
 *
 * An input may be in the domain form (encoded), or in the stored form (decoded, then encoded:
 * `decode` lifts a plain object to a `Schema.Class` instance, and a substituted date or `Redacted`
 * transform takes either form). Where neither takes it whole, it may be in the domain form but for
 * a field given `undefined` whose decode makes something of `undefined`, a decoding default
 * (#236): that field holds what a decode makes of it, and the input is encoded. So
 * `{ n: 1, data: undefined }` beside `n: Schema.NumberFromString` stores `data`'s default, as
 * `{ n: "1", data: undefined }` does, and as `{ n: 1, data: undefined }` does beside
 * `n: Schema.Number`. An input either of the first two takes is written as it was, and one none
 * takes is refused with the first two's issues, as it was.
 */

import { getSchemaFields } from "@effect-dynamodb/schema/internal/EntitySchemas.js"
import { Effect, Schema } from "effect"

/** Why no form took an input: the domain form's issue, and the stored form's. */
export interface InputFormIssues {
  readonly domain: unknown
  readonly stored: unknown
}

/**
 * `input` with each field it gives as `undefined`, and whose decode makes something of `undefined`,
 * holding what that decode makes of it, in the domain form; `undefined` when it gives no such field.
 * Effect's decoder decides, a field at a time: a field that decodes `undefined` to `undefined`, or
 * refuses it, is left as given.
 */
const withDecodedUndefineds = (
  schema: Schema.Codec<any>,
  input: unknown,
): Effect.Effect<Record<string, unknown> | undefined> => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return Effect.succeed(undefined)
  }
  const fields = getSchemaFields(schema as unknown as Schema.Top)
  if (fields === undefined) return Effect.succeed(undefined)
  const given = input as Record<string, unknown>
  const names = Object.keys(given).filter(
    (name) => given[name] === undefined && Object.hasOwn(fields, name),
  )
  if (names.length === 0) return Effect.succeed(undefined)
  return Effect.forEach(names, (name) =>
    Schema.decodeUnknownEffect(
      Schema.Struct({ [name]: fields[name]! }) as unknown as Schema.Codec<any>,
    )({ [name]: undefined }).pipe(
      Effect.map((decoded) => [name, (decoded as Record<string, unknown>)[name]] as const),
      Effect.orElseSucceed(() => [name, undefined] as const),
    ),
  ).pipe(
    Effect.map((decoded) => {
      const filled = decoded.filter(([, value]) => value !== undefined)
      return filled.length === 0 ? undefined : { ...given, ...Object.fromEntries(filled) }
    }),
  )
}

/** `input` in its stored form, or why no form takes it. */
export const encodeInput = (
  schema: Schema.Codec<any>,
  input: unknown,
): Effect.Effect<unknown, InputFormIssues> =>
  Schema.encodeUnknownEffect(schema)(input).pipe(
    Effect.catch((domain) =>
      Schema.decodeUnknownEffect(schema)(input).pipe(
        Effect.flatMap((decoded) => Schema.encodeUnknownEffect(schema)(decoded)),
        Effect.catch((stored) =>
          withDecodedUndefineds(schema, input).pipe(
            Effect.flatMap((defaulted) =>
              defaulted === undefined
                ? Effect.fail(stored)
                : Schema.encodeUnknownEffect(schema)(defaulted).pipe(Effect.mapError(() => stored)),
            ),
            Effect.mapError((): InputFormIssues => ({ domain, stored })),
          ),
        ),
      ),
    ),
  )
