/**
 * A cascade's requests as a fixture captured before #132, with the guard each cascade update has
 * carried since: `#held = :held`, the target's cascade-index partition-key attribute as the
 * cascade's query found it (`#pk` / `:pk` of the `Query` before it). Nothing else of a request
 * changes, so a test comparing a fixture byte for byte compares it through this.
 */

type Sent = { readonly command: string; readonly input: unknown }

type Held = { readonly attribute: string; readonly value: unknown }

const guarded = (update: Record<string, any>, held: Held): Record<string, any> => ({
  ...update,
  ConditionExpression: "#held = :held",
  ExpressionAttributeNames: { ...update.ExpressionAttributeNames, "#held": held.attribute },
  ExpressionAttributeValues: { ...update.ExpressionAttributeValues, ":held": held.value },
})

/** Each `UpdateItem` / `TransactWriteItems` after an index `Query`, guarded on what it queried. */
export const withCascadeGuard = <S extends Sent>(requests: ReadonlyArray<S>): ReadonlyArray<S> => {
  let held: Held | undefined
  return requests.map((sent) => {
    const input = sent.input as Record<string, any>
    if (sent.command === "Query" && input.IndexName !== undefined) {
      held = {
        attribute: input.ExpressionAttributeNames["#pk"],
        value: input.ExpressionAttributeValues[":pk"],
      }
      return sent
    }
    if (held === undefined) return sent
    if (sent.command === "UpdateItem" && input.UpdateExpression === "SET #ref = :refData") {
      return { ...sent, input: guarded(input, held) }
    }
    if (sent.command === "TransactWriteItems") {
      const at = held
      return {
        ...sent,
        input: {
          ...input,
          TransactItems: input.TransactItems.map((item: Record<string, any>) =>
            item.Update?.UpdateExpression === "SET #ref = :refData"
              ? { ...item, Update: guarded(item.Update, at) }
              : item,
          ),
        },
      }
    }
    return sent
  })
}
