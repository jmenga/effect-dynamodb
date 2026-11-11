/**
 * @internal A read that dies where 1.39.0's failed fails as 1.39.0's did.
 *
 * A read schema reads an absent attribute as the value it stands for (`absentStored`), through the
 * field's own steps, so a step that throws on that value kills a read that 1.39.0, reading no such
 * value, failed on the missing key with a `ValidationError`. Every read of a stored row, item,
 * event or effect goes through {@link failingAsBefore}: an entity's (`missingKeyOnDefect`), an
 * aggregate's assembly, and a stream's events, metadata, snapshot state and outbox effects
 * ({@link decodingAsBefore}).
 */
import { Cause, Effect, Exit, Option, Schema, type SchemaIssue, SchemaParser } from "effect"

/**
 * A read that died fails with the issue 1.39.0's read of the same input gave (`before`), through
 * `fail`; without one, it dies as it did. `before` is asked only once the read has died, so a read
 * that doesn't die runs nothing more.
 */
export const failingAsBefore =
  <E>(before: () => SchemaIssue.Issue | undefined, fail: (cause: Schema.SchemaError) => E) =>
  <A, E0, R>(read: Effect.Effect<A, E0, R>): Effect.Effect<A, E0 | E, R> =>
    Effect.catchDefect(read, (defect) => {
      let issue: SchemaIssue.Issue | undefined
      try {
        issue = before()
      } catch {
        issue = undefined
      }
      return issue === undefined
        ? Effect.die(defect)
        : Effect.fail(fail(new Schema.SchemaError(issue)))
    })

/** The issue decoding `input` through `schema` fails with; none where it decodes, or dies. */
export const issueDecoding = (
  schema: Schema.Top,
  input: unknown,
): SchemaIssue.Issue | undefined => {
  const read = SchemaParser.decodeUnknownExit(schema as unknown as Schema.Codec<unknown>)(input)
  return Exit.isFailure(read) ? Option.getOrUndefined(Cause.findErrorOption(read.cause)) : undefined
}

/**
 * Decode through `read`, a read schema built from `declared`; a decode that dies fails with the
 * issue `declared` itself gives, as 1.39.0, which decoded through `declared`, did.
 */
export const decodingAsBefore = (read: Schema.Top, declared: Schema.Top) => {
  const decode = Schema.decodeUnknownEffect(read as unknown as Schema.Codec<unknown>)
  return (input: unknown): Effect.Effect<unknown, Schema.SchemaError> =>
    decode(input).pipe(
      failingAsBefore(
        () => issueDecoding(declared, input),
        (cause) => cause,
      ),
    )
}
