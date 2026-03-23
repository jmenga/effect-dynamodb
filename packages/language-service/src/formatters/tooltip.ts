import type { DynamoDBParams } from "../core/ParamsBuilder"

export function formatTooltip(params: DynamoDBParams): string {
  // V2 info-based tooltips — return info directly for new patterns
  if (params.info) {
    return params.info
  }

  const lines: Array<string> = []

  lines.push(`${params.command}({`)

  lines.push(`  TableName: "${params.TableName}",`)

  if (params.IndexName) {
    lines.push(`  IndexName: "${params.IndexName}",`)
  }

  if (params.Key) {
    lines.push("  Key: {")
    for (const [field, value] of Object.entries(params.Key)) {
      lines.push(`    ${field}: "${value}",`)
    }
    lines.push("  },")
  }

  if (params.Item) {
    lines.push("  Item: {")
    for (const [field, value] of Object.entries(params.Item)) {
      lines.push(`    ${field}: "${value}",`)
    }
    lines.push("    ...  // model fields")
    lines.push("  },")
  }

  if (params.KeyConditionExpression) {
    lines.push(`  KeyConditionExpression: "${params.KeyConditionExpression}",`)
  }

  if (params.FilterExpression) {
    lines.push(`  FilterExpression: "${params.FilterExpression}",`)
  }

  if (params.UpdateExpression) {
    lines.push(`  UpdateExpression: "${params.UpdateExpression}",`)
  }

  if (params.ConditionExpression) {
    lines.push(`  ConditionExpression: "${params.ConditionExpression}",`)
  }

  if (params.ExpressionAttributeNames) {
    lines.push(`  ExpressionAttributeNames: {`)
    for (const [key, value] of Object.entries(params.ExpressionAttributeNames)) {
      lines.push(`    "${key}": "${value}",`)
    }
    lines.push("  },")
  }

  if (params.ExpressionAttributeValues) {
    lines.push(`  ExpressionAttributeValues: {`)
    for (const [key, value] of Object.entries(params.ExpressionAttributeValues)) {
      lines.push(`    "${key}": "${value}",`)
    }
    lines.push("  },")
  }

  lines.push("})")

  return lines.join("\n")
}
