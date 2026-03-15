import { describe, expect, it } from "vitest"
import type { ResolvedEntity } from "../src/core/EntityResolver"
import type { DetectedOperation } from "../src/core/OperationDetector"
import { buildParams } from "../src/core/ParamsBuilder"

const userEntity: ResolvedEntity = {
  variableName: "Users",
  entityType: "User",
  schema: { name: "crud-demo", version: 1, casing: "lowercase" },
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["userId"] },
      sk: { field: "sk", composite: [] },
    },
    byRole: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["role"] },
      sk: { field: "gsi1sk", composite: ["userId"] },
    },
  },
  timestamps: true,
  versioned: true,
  softDelete: false,
  unique: undefined,
}

const taskEntity: ResolvedEntity = {
  variableName: "Tasks",
  entityType: "Task",
  schema: { name: "crud-demo", version: 1, casing: "lowercase" },
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["taskId"] },
      sk: { field: "sk", composite: [] },
    },
    byUser: {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["userId"] },
      sk: { field: "gsi1sk", composite: ["status", "taskId"] },
    },
  },
  timestamps: true,
  versioned: true,
  softDelete: true,
  unique: undefined,
}

describe("ParamsBuilder", () => {
  describe("GetItem", () => {
    it("should build GetItemCommand params with literal key values", () => {
      const op: DetectedOperation = {
        entity: userEntity,
        type: "get",
        arguments: { userId: "u-alice" },
      }

      const params = buildParams(op)

      expect(params.command).toBe("GetItemCommand")
      expect(params.Key).toBeDefined()
      expect(params.Key!.pk).toBe("$crud-demo#v1#user#u-alice")
      expect(params.Key!.sk).toBe("$crud-demo#v1#user")
      expect(params.entityType).toBe("User")
    })

    it("should use placeholder for non-literal key values", () => {
      const op: DetectedOperation = {
        entity: userEntity,
        type: "get",
        arguments: { userId: undefined as any },
      }

      const params = buildParams(op)

      expect(params.Key!.pk).toBe("$crud-demo#v1#user#{userId}")
    })
  })

  describe("PutItem", () => {
    it("should build PutItemCommand params with Item", () => {
      const op: DetectedOperation = {
        entity: userEntity,
        type: "put",
        arguments: { userId: "u-bob", role: "member" },
      }

      const params = buildParams(op)

      expect(params.command).toBe("PutItemCommand")
      expect(params.Item).toBeDefined()
      expect(params.Item!.pk).toBe("$crud-demo#v1#user#u-bob")
      expect(params.Item!.__edd_e__).toBe("User")
      expect(params.Item!.createdAt).toBe("{now}")
      expect(params.entityType).toBe("User")
    })

    it("should use TransactWriteItemsCommand when unique constraints exist", () => {
      const entityWithUnique: ResolvedEntity = {
        ...userEntity,
        unique: { email: { fields: ["email"] } },
      }
      const op: DetectedOperation = {
        entity: entityWithUnique,
        type: "put",
      }

      const params = buildParams(op)

      expect(params.command).toBe("TransactWriteItemsCommand")
    })
  })

  describe("CreateItem", () => {
    it("should build PutItemCommand with attribute_not_exists condition", () => {
      const op: DetectedOperation = {
        entity: userEntity,
        type: "create",
        arguments: { userId: "u-new" },
      }

      const params = buildParams(op)

      expect(params.command).toBe("PutItemCommand")
      expect(params.ConditionExpression).toContain("attribute_not_exists(#pk)")
      expect(params.ExpressionAttributeNames).toBeDefined()
      expect(params.ExpressionAttributeNames!["#pk"]).toBe("pk")
    })
  })

  describe("UpdateItem", () => {
    it("should build UpdateItemCommand params with key and expressions", () => {
      const op: DetectedOperation = {
        entity: userEntity,
        type: "update",
        arguments: { userId: "u-alice" },
        updateCombinators: {
          set: { role: "member", displayName: "Alice W." },
        },
      }

      const params = buildParams(op)

      expect(params.command).toBe("UpdateItemCommand")
      expect(params.Key!.pk).toBe("$crud-demo#v1#user#u-alice")
      expect(params.UpdateExpression).toContain("SET")
      expect(params.UpdateExpression).toContain("#role")
      expect(params.UpdateExpression).toContain("#displayName")
      expect(params.UpdateExpression).toContain("#updatedAt")
      expect(params.UpdateExpression).toContain("#__edd_v__")
      expect(params.ExpressionAttributeNames).toBeDefined()
      expect(params.ExpressionAttributeNames!["#role"]).toBe("role")
      expect(params.ExpressionAttributeValues).toBeDefined()
      expect(params.ExpressionAttributeValues![":role"]).toBe("member")
    })

    it("should include condition for expectedVersion", () => {
      const op: DetectedOperation = {
        entity: userEntity,
        type: "update",
        arguments: { userId: "u-alice" },
        updateCombinators: {
          set: { role: "member" },
          expectedVersion: 2,
        },
      }

      const params = buildParams(op)

      expect(params.ConditionExpression).toBe("#__edd_v__ = :expectedVersion")
      expect(params.ExpressionAttributeValues![":expectedVersion"]).toBe("2")
    })
  })

  describe("DeleteItem", () => {
    it("should build DeleteItemCommand for non-soft-delete entity", () => {
      const op: DetectedOperation = {
        entity: userEntity,
        type: "delete",
        arguments: { userId: "u-alice" },
      }

      const params = buildParams(op)

      expect(params.command).toBe("DeleteItemCommand")
      expect(params.Key!.pk).toBe("$crud-demo#v1#user#u-alice")
    })

    it("should build TransactWriteItemsCommand for soft-delete entity", () => {
      const op: DetectedOperation = {
        entity: taskEntity,
        type: "delete",
        arguments: { taskId: "t-1" },
      }

      const params = buildParams(op)

      expect(params.command).toBe("TransactWriteItemsCommand")
    })
  })

  describe("Query", () => {
    it("should build QueryCommand params for GSI with expression attributes", () => {
      const op: DetectedOperation = {
        entity: userEntity,
        type: "query",
        indexName: "byRole",
        arguments: { role: "admin" },
      }

      const params = buildParams(op)

      expect(params.command).toBe("QueryCommand")
      expect(params.IndexName).toBe("gsi1")
      expect(params.KeyConditionExpression).toContain("#pk = :pk")
      expect(params.FilterExpression).toBe("#et IN (:et0)")
      expect(params.ExpressionAttributeNames!["#pk"]).toBe("gsi1pk")
      expect(params.ExpressionAttributeValues![":pk"]).toBe("$crud-demo#v1#user#admin")
      expect(params.ExpressionAttributeValues![":et0"]).toBe("User")
    })

    it("should build QueryCommand params with SK prefix", () => {
      const op: DetectedOperation = {
        entity: taskEntity,
        type: "query",
        indexName: "byUser",
        arguments: { userId: "u-alice" },
      }

      const params = buildParams(op)

      expect(params.command).toBe("QueryCommand")
      expect(params.KeyConditionExpression).toContain("begins_with(#sk, :skPrefix)")
      expect(params.ExpressionAttributeValues![":pk"]).toBe("$crud-demo#v1#task#u-alice")
    })
  })

  describe("Scan", () => {
    it("should build ScanCommand params with filter expression", () => {
      const op: DetectedOperation = {
        entity: userEntity,
        type: "scan",
      }

      const params = buildParams(op)

      expect(params.command).toBe("ScanCommand")
      expect(params.FilterExpression).toBe("#et IN (:et0)")
      expect(params.ExpressionAttributeNames!["#et"]).toBe("__edd_e__")
      expect(params.ExpressionAttributeValues![":et0"]).toBe("User")
    })
  })
})
