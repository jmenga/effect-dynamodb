/**
 * The row token (`__edd_rt__`, #237) taken out of requests and stored items, to compare a read
 * model two projections write with what 1.40.0 sent and stored for it: the token's attribute, and
 * every condition term naming it (`#eddRt`), a row's bookkeeping as read (`#eddTb<i>`) or a
 * tombstone's removal stamp (`#eddRm`), with their placeholders, and the `ALL_OLD` a request
 * naming the token asks for. What is left must equal 1.40.0's request exactly.
 */

const TOKEN = "__edd_rt__"
const PLACEHOLDER = /^[#:]edd(Rt|Tb\d+|Rm)$/
const TERM = /[#:]edd(Rt|Tb\d+|Rm)\b/

/** The top-level parts of `expression` joined by ` AND `, each parenthesised one unwrapped. */
const conjuncts = (expression: string): ReadonlyArray<string> => {
  const parts: Array<string> = []
  let depth = 0
  let start = 0
  for (let i = 0; i < expression.length; i++) {
    const char = expression[i]
    if (char === "(") depth++
    else if (char === ")") depth--
    else if (depth === 0 && expression.startsWith(" AND ", i)) {
      parts.push(expression.slice(start, i))
      start = i + 5
      i += 4
    }
  }
  parts.push(expression.slice(start))
  const unwrap = (part: string): string => {
    if (!part.startsWith("(") || !part.endsWith(")")) return part
    let level = 0
    for (let i = 0; i < part.length; i++) {
      if (part[i] === "(") level++
      else if (part[i] === ")") level--
      if (level === 0 && i < part.length - 1) return part
    }
    return part.slice(1, -1)
  }
  return parts.map(unwrap)
}

/** Whether `value` (a request, or what's stored) names the row token anywhere. */
export const namesRowToken = (value: unknown): boolean => JSON.stringify(value).includes(TOKEN)

/** `value` with the row token taken out (see the module's comment). */
export const withoutRowToken = <A>(value: A): A => {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk)
    if (typeof node !== "object" || node === null) return node
    const record = node as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(record)) {
      if (key === TOKEN) continue
      out[key] = walk(v)
    }
    const expression = out.ConditionExpression
    if (typeof expression === "string" && TERM.test(expression)) {
      const kept = conjuncts(expression).filter((part) => !TERM.test(part))
      if (kept.length === 0) delete out.ConditionExpression
      else
        out.ConditionExpression =
          kept.length === 1 ? kept[0] : kept.map((p) => `(${p})`).join(" AND ")
      delete out.ReturnValuesOnConditionCheckFailure
      for (const map of ["ExpressionAttributeNames", "ExpressionAttributeValues"] as const) {
        const held = out[map] as Record<string, unknown> | undefined
        if (held === undefined) continue
        const left = Object.fromEntries(
          Object.entries(held).filter(([placeholder]) => !PLACEHOLDER.test(placeholder)),
        )
        if (Object.keys(left).length === 0) delete out[map]
        else out[map] = left
      }
    }
    return out
  }
  return walk(value) as A
}
