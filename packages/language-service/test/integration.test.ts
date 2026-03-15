import ts from "typescript"
import { describe, expect, it } from "vitest"
import { resolveEntities } from "../src/core/EntityResolver"
import { detectOperation } from "../src/core/OperationDetector"
import { buildParams } from "../src/core/ParamsBuilder"
import { formatTooltip } from "../src/formatters/tooltip"

function parseSource(source: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

describe("Integration: Entity definition → hover tooltip", () => {
  const fullSource = `
    const AppSchema = DynamoSchema.make({ name: "crud-demo", version: 1 })
    const MainTable = Table.make({ schema: AppSchema })

    const Users = Entity.make({
      model: User,
      table: MainTable,
      entityType: "User",
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
    })

    const Tasks = Entity.make({
      model: Task,
      table: MainTable,
      entityType: "Task",
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
      softDelete: true,
    })
  `

  it("should resolve entities and produce tooltip for get operation", () => {
    const source = `${fullSource}\nUsers.get({ userId: "u-alice" })`
    const sf = parseSource(source)
    const entities = resolveEntities(ts, sf)

    expect(entities).toHaveLength(2)

    const getPos = source.lastIndexOf(".get(") + 1
    const op = detectOperation(ts, sf, getPos, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("get")

    const params = buildParams(op!)

    expect(params.command).toBe("GetItemCommand")
    expect(params.Key!.pk).toBe("$crud-demo#v1#user#u-alice")
    expect(params.Key!.sk).toBe("$crud-demo#v1#user")

    const tooltip = formatTooltip(params)

    expect(tooltip).toContain("GetItemCommand({")
    expect(tooltip).toContain("$crud-demo#v1#user#u-alice")
  })

  it("should produce tooltip for query with GSI", () => {
    const source = `${fullSource}\nUsers.query.byRole({ role: "admin" })`
    const sf = parseSource(source)
    const entities = resolveEntities(ts, sf)

    const byRolePos = source.lastIndexOf("byRole(")
    const op = detectOperation(ts, sf, byRolePos, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("query")
    expect(op!.indexName).toBe("byRole")

    const params = buildParams(op!)

    expect(params.command).toBe("QueryCommand")
    expect(params.IndexName).toBe("gsi1")
    expect(params.ExpressionAttributeValues![":pk"]).toBe("$crud-demo#v1#user#admin")

    const tooltip = formatTooltip(params)
    expect(tooltip).toContain("QueryCommand({")
    expect(tooltip).toContain('IndexName: "gsi1"')
  })

  it("should produce tooltip for update with set combinators", () => {
    const source =
      fullSource +
      `
    Users.update({ userId: "u-alice" }).pipe(
      Users.set({ role: "member", displayName: "Alice W." }),
    )`
    const sf = parseSource(source)
    const entities = resolveEntities(ts, sf)

    const updatePos = source.lastIndexOf(".update(") + 1
    const op = detectOperation(ts, sf, updatePos, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("update")

    const params = buildParams(op!)

    expect(params.command).toBe("UpdateItemCommand")
    expect(params.Key!.pk).toBe("$crud-demo#v1#user#u-alice")
    expect(params.UpdateExpression).toContain("SET")
  })

  it("should produce tooltip for scan", () => {
    const source = `${fullSource}\nUsers.scan()`
    const sf = parseSource(source)
    const entities = resolveEntities(ts, sf)

    const scanPos = source.lastIndexOf(".scan(") + 1
    const op = detectOperation(ts, sf, scanPos, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("scan")

    const params = buildParams(op!)

    expect(params.command).toBe("ScanCommand")
    expect(params.FilterExpression).toContain(":et0")
    expect(params.ExpressionAttributeValues![":et0"]).toBe("User")
  })

  it("should produce tooltip for delete with soft-delete", () => {
    const source = `${fullSource}\nTasks.delete({ taskId: "t-1" })`
    const sf = parseSource(source)
    const entities = resolveEntities(ts, sf)

    const deletePos = source.lastIndexOf(".delete(") + 1
    const op = detectOperation(ts, sf, deletePos, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("delete")

    const params = buildParams(op!)

    expect(params.command).toBe("TransactWriteItemsCommand")
    expect(params.Key!.pk).toBe("$crud-demo#v1#task#t-1")
  })

  it("should produce tooltip for put", () => {
    const source =
      fullSource +
      `\nUsers.put({ userId: "u-new", email: "new@x.com", displayName: "New", role: "member", createdBy: "sys" })`
    const sf = parseSource(source)
    const entities = resolveEntities(ts, sf)

    const putPos = source.lastIndexOf(".put(") + 1
    const op = detectOperation(ts, sf, putPos, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("put")

    const params = buildParams(op!)
    expect(params.command).toBe("PutItemCommand")
    expect(params.Item).toBeDefined()
    expect(params.Item!.__edd_e__).toBe("User")

    const tooltip = formatTooltip(params)
    expect(tooltip).toContain("PutItemCommand({")
    expect(tooltip).toContain("Item: {")
  })

  it("should handle entity with collection indexes", () => {
    const source = `
      const AppSchema = DynamoSchema.make({ name: "shop", version: 1 })
      const MainTable = Table.make({ schema: AppSchema })

      const Orders = Entity.make({
        model: Order,
        table: MainTable,
        entityType: "Order",
        indexes: {
          primary: {
            pk: { field: "pk", composite: ["orderId"] },
            sk: { field: "sk", composite: [] },
          },
          byCustomer: {
            index: "gsi1",
            collection: "customerOrders",
            pk: { field: "gsi1pk", composite: ["customerId"] },
            sk: { field: "gsi1sk", composite: ["orderDate"] },
          },
        },
      })

      Orders.query.byCustomer({ customerId: "c-123" })
    `
    const sf = parseSource(source)
    const entities = resolveEntities(ts, sf)

    expect(entities).toHaveLength(1)
    expect(entities[0]!.indexes.byCustomer!.collection).toBe("customerOrders")

    const queryPos = source.lastIndexOf("byCustomer(")
    const op = detectOperation(ts, sf, queryPos, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("query")

    const params = buildParams(op!)

    expect(params.ExpressionAttributeValues![":pk"]).toBe("$shop#v1#customerorders#c-123")
  })
})
