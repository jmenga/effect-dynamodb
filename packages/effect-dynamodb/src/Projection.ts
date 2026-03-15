/**
 * Projection — Select specific attributes in get/query operations.
 *
 * Projections reduce read capacity and network transfer by fetching only
 * the requested attributes. The result is a partial record (not decoded
 * through the full entity schema, since projected items may not match).
 *
 * Usage:
 * - projection(["name", "email"]) → { expression, names }
 * - Pass to get/query operations via ProjectionExpression + ExpressionAttributeNames
 */

export interface ProjectionResult {
  readonly expression: string
  readonly names: Record<string, string>
}

/**
 * Build a ProjectionExpression from a list of attribute names.
 * Uses ExpressionAttributeNames to safely handle reserved words.
 *
 * @example
 * ```ts
 * const proj = Projection.projection(["name", "email", "status"])
 * // proj.expression === "#proj_name, #proj_email, #proj_status"
 * // proj.names === { "#proj_name": "name", "#proj_email": "email", "#proj_status": "status" }
 * ```
 */
export const projection = (attributes: ReadonlyArray<string>): ProjectionResult => {
  if (attributes.length === 0) {
    return { expression: "", names: {} }
  }

  const names: Record<string, string> = {}
  const parts: Array<string> = []

  for (const attr of attributes) {
    const placeholder = `#proj_${attr}`
    names[placeholder] = attr
    parts.push(placeholder)
  }

  return {
    expression: parts.join(", "),
    names,
  }
}
