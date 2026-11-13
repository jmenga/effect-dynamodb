/**
 * @internal The readings of a row's key values `rekey` looks for the row under (#242).
 *
 * Each earlier release composed a key composite's text its own way: 1.39.0 a codec's text encoded
 * once more (`keyForm139`), 1.38.0 to 1.40.0 on Effect 4.1.3 a zone under the name it was given
 * (`givenZoneReading`), 1.39.0's and 1.40.0's `restore` a look-alike stored as a map under the map's
 * text (`restoredObjectReading`). One row can hold composites of more than one such kind: 1.39.0 on
 * Effect 4.1.3 restored an item keyed by a `Duration` and a date zoned in `Etc/UTC` under
 * `…#d_[object object]#at_…[etc/utc]`, each composite read its own way. So a reading is chosen
 * composite by composite: each composite takes its value in the key form, or any other value an
 * earlier reading gives it, and the readings are every combination of those ({@link keyReadings}).
 * The key form's forms of text (1.36's, 1.37's, the escaped one) are tried for each reading, as
 * every reading is.
 */

/**
 * How many readings of one row's key values `rekey` tries at most: every combination of up to six
 * composites read two ways each, or three composites read four ways. Past it, the combinations
 * changing the most composites aren't tried, and a row stored under one of them is left where it
 * is and counted `unrecognizedKey`. Each earlier reading by itself is always tried.
 */
export const READINGS_BOUND = 64

/** A composite a reading doesn't hold. */
const ABSENT: unique symbol = Symbol.for("effect-dynamodb/KeyReadings/absent")

const valueIn = (reading: Record<string, unknown>, attr: string): unknown =>
  Object.hasOwn(reading, attr) ? reading[attr] : ABSENT

const sameReading = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  for (const attr of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!Object.is(valueIn(a, attr), valueIn(b, attr))) return false
  }
  return true
}

/**
 * The readings of a row's key values: `keyForm` (the key form's), then each of `others` (an
 * earlier release's reading of them, or `undefined` for none) by itself, then every other
 * combination of their values composite by composite, fewest composites changed first, up to
 * {@link READINGS_BOUND} readings in all. No reading twice. A row with no other reading has the key
 * form's alone, and costs nothing more.
 */
export const keyReadings = (
  keyForm: Record<string, unknown>,
  others: ReadonlyArray<Record<string, unknown> | undefined>,
): ReadonlyArray<Record<string, unknown>> => {
  const readings: Array<Record<string, unknown>> = [keyForm]
  const add = (reading: Record<string, unknown>) => {
    if (readings.length < READINGS_BOUND && !readings.some((had) => sameReading(had, reading))) {
      readings.push(reading)
    }
  }
  // A composite an earlier reading leaves out is read as the key form reads it: a key holds them all.
  const earlier = others.flatMap((other) => (other === undefined ? [] : [{ ...keyForm, ...other }]))
  for (const other of earlier) add(other)
  // Each composite's values other than the key form's, from any earlier reading.
  const choices: Array<readonly [string, ReadonlyArray<unknown>]> = []
  const attrs = new Set([
    ...Object.keys(keyForm),
    ...earlier.flatMap((other) => Object.keys(other)),
  ])
  for (const attr of attrs) {
    const now = valueIn(keyForm, attr)
    const values: Array<unknown> = []
    for (const other of earlier) {
      const value = valueIn(other, attr)
      if (value === ABSENT || Object.is(value, now)) continue
      if (!values.some((had) => Object.is(had, value))) values.push(value)
    }
    if (values.length > 0) choices.push([attr, values])
  }
  const readingWith = (changes: ReadonlyArray<readonly [string, unknown]>) => {
    const reading = { ...keyForm }
    for (const [attr, value] of changes) reading[attr] = value
    return reading
  }
  // Changing `count` composites, from the `from`th choice on.
  const combine = (
    count: number,
    from: number,
    changes: Array<readonly [string, unknown]>,
  ): void => {
    if (readings.length >= READINGS_BOUND) return
    if (changes.length === count) {
      add(readingWith(changes))
      return
    }
    for (let at = from; at < choices.length; at++) {
      const [attr, values] = choices[at]!
      for (const value of values) {
        changes.push([attr, value])
        combine(count, at + 1, changes)
        changes.pop()
        if (readings.length >= READINGS_BOUND) return
      }
    }
  }
  for (let count = 1; count <= choices.length && readings.length < READINGS_BOUND; count++) {
    combine(count, 0, [])
  }
  return readings
}
