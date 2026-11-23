/**
 * @internal `commandHandler`'s opt-in `checkStateUse` (#290): the two checks
 * that the state contract holds for one command.
 *
 * - **`decide` only reads its state (EDD-9183).** The state is fingerprinted
 *   before `decide` is called and again once it has finished (succeeded or
 *   failed with its own error), and a difference is a defect naming the stream,
 *   the command and the first changed path. A defect or an interruption of
 *   `decide` passes through unchecked.
 * - **A shared `initialState` stays as declared (EDD-9184).** When
 *   `decider.initialState` reads as the same object twice (a value, not a
 *   getter), it is fingerprinted when an attempt starts and checked after the
 *   load and after the new events are folded, before the append: an `evolve`
 *   that changes its state in place changes this object, and every later new
 *   stream would start from it.
 *
 * With an encoder (the stream's snapshot state schema), a state is compared as
 * the snapshot would store it, so a value is compared by what it means, not by
 * the fields a class keeps. The plain walk is the fallback, for a stream
 * without a snapshot schema or a state that does not encode on either side.
 *
 * Nothing here runs unless the option is on: `commandHandler` does not build
 * a check otherwise.
 */

import { Effect, Result } from "effect"
import * as StateFingerprint from "./StateFingerprint.js"

/** @internal Encodes a state as the stream's snapshot would store it. */
export type StateEncoder = (state: unknown) => Effect.Effect<unknown, unknown>

/** @internal What a defect names: the stream and the command. */
export interface Subject {
  readonly streamName: string
  readonly streamId: string
  readonly command: unknown
}

/** @internal A shared `initialState` object, watched over one attempt. */
export interface InitialStateWatch {
  readonly object: object
  /** Dies with EDD-9184 when the object changed since the watch began. */
  readonly check: (moment: "load" | "fold") => Effect.Effect<void>
}

/** @internal */
export interface StateUseCheck {
  /**
   * Run `decide` (the thunk calls it, so a change made before its `Effect` is
   * returned is seen too) and die with EDD-9183 when `state` changed.
   */
  readonly decide: <A, E>(
    subject: Subject,
    state: unknown,
    initial: InitialStateWatch | undefined,
    run: () => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>
  /**
   * Begin watching `decider.initialState` (`read` reads the property), or
   * `undefined` when it is a getter or not an object.
   */
  readonly watchInitialState: (
    subject: Subject,
    read: () => unknown,
  ) => Effect.Effect<InitialStateWatch | undefined>
}

interface Taken {
  readonly raw: StateFingerprint.Fingerprint
  /** `undefined` without an encoder, or when the state does not encode. */
  readonly encoded: StateFingerprint.Fingerprint | undefined
}

/** @internal */
export const make = (encode: StateEncoder | undefined): StateUseCheck => {
  const take = (state: unknown): Effect.Effect<Taken> => {
    const raw = Effect.sync(() => StateFingerprint.of(state))
    if (encode === undefined)
      return Effect.map(raw, (fingerprint) => ({ raw: fingerprint, encoded: undefined }))
    // Encode first: an encoding can fill a cache the state keeps (a getter
    // that memoises), and the walk must see that on both sides, or the check's
    // own encoding would be reported as a change `decide` made.
    return Effect.flatMap(Effect.result(encode(state)), (encoded) =>
      Effect.map(raw, (fingerprint) => ({
        raw: fingerprint,
        encoded: Result.isSuccess(encoded) ? StateFingerprint.of(encoded.success) : undefined,
      })),
    )
  }

  const compare = (before: Taken, after: Taken): StateFingerprint.Difference | undefined =>
    before.encoded !== undefined && after.encoded !== undefined
      ? StateFingerprint.firstDifference(before.encoded, after.encoded)
      : StateFingerprint.firstDifference(before.raw, after.raw)

  const decide = <A, E>(
    subject: Subject,
    state: unknown,
    initial: InitialStateWatch | undefined,
    run: () => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.gen(function* () {
      const before = yield* take(state)
      const result = yield* Effect.result(Effect.suspend(run))
      const difference = compare(before, yield* take(state))
      if (difference !== undefined) {
        const shared = initial !== undefined && initial.object === state
        return yield* Effect.die(new Error(decideMessage(subject, difference, shared)))
      }
      return Result.isSuccess(result) ? result.success : yield* Effect.fail(result.failure)
    })

  const watchInitialState = (
    subject: Subject,
    read: () => unknown,
  ): Effect.Effect<InitialStateWatch | undefined> =>
    Effect.gen(function* () {
      const object = read()
      if (object === null || typeof object !== "object") return undefined
      // A getter returns a fresh value on every read, so no change can carry
      // over to another stream: only a shared object needs watching.
      if (read() !== object) return undefined
      const before = yield* take(object)
      const watch: InitialStateWatch = {
        object,
        check: (moment) =>
          Effect.gen(function* () {
            const difference = compare(before, yield* take(object))
            if (difference !== undefined) {
              return yield* Effect.die(new Error(initialStateMessage(subject, difference, moment)))
            }
          }),
      }
      return watch
    })

  return { decide, watchInitialState }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const commandLabel = (command: unknown): string => {
  if (command !== null && typeof command === "object") {
    const tag = (command as { readonly _tag?: unknown })._tag
    return typeof tag === "string" ? `command "${tag}"` : "an untagged command"
  }
  if (typeof command === "string") {
    return `command ${JSON.stringify(command.length > 40 ? `${command.slice(0, 40)}…` : command)}`
  }
  return typeof command === "function" ? "a function command" : `command ${String(command)}`
}

const where = (difference: StateFingerprint.Difference): string =>
  `at ${StateFingerprint.formatPath(difference.path)} (was ${difference.before}, now ${difference.after})`

const subjectLabel = (subject: Subject): string =>
  `EventStream "${subject.streamName}" (${subject.streamId}), ${commandLabel(subject.command)}`

const decideMessage = (
  subject: Subject,
  difference: StateFingerprint.Difference,
  shared: boolean,
): string =>
  `[EDD-9183] ${subjectLabel(subject)}: decide changed the state it was given, ${where(difference)}. ` +
  "checkStateUse checks that decide only reads its state: the state is handed to decide as is, " +
  "not copied, and the fold of the new events starts from that same object, so the change " +
  "would be in the state the handler returns, projects and snapshots. Copy the state in decide " +
  "before changing it." +
  (shared
    ? " This state is decider.initialState itself, so every later new stream would start from " +
      "the change too."
    : "")

const initialStateMessage = (
  subject: Subject,
  difference: StateFingerprint.Difference,
  moment: "load" | "fold",
): string =>
  `[EDD-9184] ${subjectLabel(subject)}: decider.initialState is one shared object, and it ` +
  `changed while this command ran, ${where(difference)}, ` +
  (moment === "load"
    ? "while the stored events were folded on load. "
    : "while the new events were folded. ") +
  "An evolve that changes its state in place changes this object when a fold starts from it, " +
  "so every later new stream would start from the change. Declare initialState as a getter " +
  "that returns a fresh value (get initialState() { return { … } }), or have evolve return " +
  "new state."
