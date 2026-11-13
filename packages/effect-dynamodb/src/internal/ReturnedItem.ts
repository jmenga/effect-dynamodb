/**
 * Keeps the rows AWS returns on a failed condition out of what errors print.
 *
 * With `ReturnValuesOnConditionCheckFailure: "ALL_OLD"`, what the SDK throws holds
 * the stored item: `Item` on a `ConditionalCheckFailedException`, and
 * `CancellationReasons[i].Item` on a `TransactionCanceledException`. A tagged
 * error keeps that as its `cause`, and `JSON.stringify` and structured loggers
 * render a cause's fields, so a row's values, a redacted field's plaintext among
 * them, would reach logs.
 *
 * The verdicts read those items, and a caller may too, so they stay on the
 * exception and only stop being enumerable.
 *
 * @internal
 */

const hideItem = (holder: object): void => {
  if (Object.hasOwn(holder, "Item")) Reflect.defineProperty(holder, "Item", { enumerable: false })
}

/**
 * Hides the items {@link cause} holds, in place, and returns it. Every classifier
 * of a DynamoDB client's errors runs what it catches through this.
 *
 * @internal
 */
export const hideReturnedItems = (cause: unknown): unknown => {
  if (cause === null || typeof cause !== "object") return cause
  hideItem(cause)
  const { CancellationReasons: reasons } = cause as { readonly CancellationReasons?: unknown }
  if (Array.isArray(reasons)) {
    for (const reason of reasons) {
      if (reason !== null && typeof reason === "object") hideItem(reason)
    }
  }
  return cause
}
