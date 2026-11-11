/**
 * The input each failed data-plane request was sent with: the object the
 * client (and so the AWS SDK) received, after `Capacity` added
 * `ReturnConsumedCapacity` to it. Recorded by `Capacity`'s instrumented
 * client on failure only, keyed by the error and by that error's cause (a
 * site may wrap the error again, keeping its cause), and read by the
 * failure-time diagnosis (`WriteDiagnosis`), which measures the request as
 * sent rather than as the site built it.
 */

const sentInputs = new WeakMap<object, Readonly<Record<string, unknown>>>()

const isObject = (value: unknown): value is object => value !== null && typeof value === "object"

/** Record that `error` is the failure of a request sent with `input`. */
export const remember = (error: unknown, input: Readonly<Record<string, unknown>>): void => {
  if (!isObject(error)) return
  sentInputs.set(error, input)
  const cause = (error as { readonly cause?: unknown }).cause
  if (isObject(cause)) sentInputs.set(cause, input)
}

/** The input the request that failed with `error` was sent with, when recorded. */
export const inputOf = (error: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (!isObject(error)) return undefined
  const own = sentInputs.get(error)
  if (own !== undefined) return own
  const cause = (error as { readonly cause?: unknown }).cause
  return isObject(cause) ? sentInputs.get(cause) : undefined
}
