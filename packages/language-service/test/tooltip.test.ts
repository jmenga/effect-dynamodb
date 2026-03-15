import { describe, expect, it } from "vitest"
import type { DynamoDBParams } from "../src/core/ParamsBuilder"
import { formatTooltip } from "../src/formatters/tooltip"

describe("formatTooltip", () => {
  it("should format GetItemCommand as SDK-style params", () => {
    const params: DynamoDBParams = {
      command: "GetItemCommand",
      TableName: "{TableName}",
      Key: {
        pk: "$crud-demo#v1#user#u-alice",
        sk: "$crud-demo#v1#user",
      },
      entityType: "User",
    }

    const tooltip = formatTooltip(params)

    expect(tooltip).toContain("GetItemCommand({")
    expect(tooltip).toContain('TableName: "{TableName}"')
    expect(tooltip).toContain("Key: {")
    expect(tooltip).toContain('pk: "$crud-demo#v1#user#u-alice"')
    expect(tooltip).toContain("})")
  })

  it("should format QueryCommand with expression attributes", () => {
    const params: DynamoDBParams = {
      command: "QueryCommand",
      TableName: "{TableName}",
      IndexName: "gsi1",
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
      FilterExpression: "#et IN (:et0)",
      ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk", "#et": "__edd_e__" },
      ExpressionAttributeValues: {
        ":pk": "$crud-demo#v1#user#admin",
        ":skPrefix": "$crud-demo#v1#user",
        ":et0": "User",
      },
      entityType: "User",
    }

    const tooltip = formatTooltip(params)

    expect(tooltip).toContain("QueryCommand({")
    expect(tooltip).toContain('IndexName: "gsi1"')
    expect(tooltip).toContain("KeyConditionExpression:")
    expect(tooltip).toContain("FilterExpression:")
    expect(tooltip).toContain("ExpressionAttributeNames: {")
    expect(tooltip).toContain("ExpressionAttributeValues: {")
  })

  it("should format UpdateItemCommand with expressions", () => {
    const params: DynamoDBParams = {
      command: "UpdateItemCommand",
      TableName: "{TableName}",
      Key: {
        pk: "$crud-demo#v1#user#u-alice",
        sk: "$crud-demo#v1#user",
      },
      UpdateExpression: "SET #role = :role, #updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#role": "role", "#updatedAt": "updatedAt" },
      ExpressionAttributeValues: { ":role": "member", ":updatedAt": "{now}" },
      entityType: "User",
    }

    const tooltip = formatTooltip(params)

    expect(tooltip).toContain("UpdateItemCommand({")
    expect(tooltip).toContain("UpdateExpression:")
    expect(tooltip).toContain("SET")
    expect(tooltip).toContain("#role")
  })

  it("should format ScanCommand", () => {
    const params: DynamoDBParams = {
      command: "ScanCommand",
      TableName: "{TableName}",
      FilterExpression: "#et IN (:et0)",
      ExpressionAttributeNames: { "#et": "__edd_e__" },
      ExpressionAttributeValues: { ":et0": "User" },
      entityType: "User",
    }

    const tooltip = formatTooltip(params)

    expect(tooltip).toContain("ScanCommand({")
    expect(tooltip).toContain("FilterExpression:")
  })
})
