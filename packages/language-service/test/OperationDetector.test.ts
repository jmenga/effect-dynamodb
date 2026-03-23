import ts from "typescript"
import { describe, expect, it } from "vitest"
import type { ResolvedCollection, ResolvedEntity } from "../src/core/EntityResolver"
import { detectOperation } from "../src/core/OperationDetector"

function parseSource(source: string): ts.SourceFile {
  return ts.createSourceFile("test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

const mockEntity: ResolvedEntity = {
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

const entities = [mockEntity, taskEntity]

describe("OperationDetector", () => {
  it("should detect Users.get() operation", () => {
    const source = `Users.get({ userId: "u-alice" })`
    const sf = parseSource(source)
    // Position on "get" — the "g" of get is at index 6
    const op = detectOperation(ts, sf, 6, entities)

    expect(op).toBeDefined()
    expect(op!.entity.variableName).toBe("Users")
    expect(op!.type).toBe("get")
    expect(op!.arguments).toEqual({ userId: "u-alice" })
  })

  it("should detect Users.put() operation", () => {
    const source = `Users.put({ userId: "u-bob", email: "bob@example.com", displayName: "Bob", role: "member", createdBy: "system" })`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 6, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("put")
    expect(op!.arguments?.userId).toBe("u-bob")
  })

  it("should detect Users.create() operation", () => {
    const source = `Users.create({ userId: "u-new", email: "new@example.com" })`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 6, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("create")
  })

  it("should detect Users.update() operation", () => {
    const source = `Users.update({ userId: "u-alice" })`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 6, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("update")
    expect(op!.arguments).toEqual({ userId: "u-alice" })
  })

  it("should detect Users.delete() operation", () => {
    const source = `Users.delete({ userId: "u-alice" })`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 6, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("delete")
  })

  it("should detect Users.query.byRole() operation", () => {
    const source = `Users.query.byRole({ role: "admin" })`
    const sf = parseSource(source)
    // Position on "byRole" — after "Users.query."
    const op = detectOperation(ts, sf, 13, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("query")
    expect(op!.indexName).toBe("byRole")
    expect(op!.arguments).toEqual({ role: "admin" })
  })

  it("should detect Tasks.query.byUser() with multiple arguments", () => {
    const source = `Tasks.query.byUser({ userId: "u-alice" })`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 13, entities)

    expect(op).toBeDefined()
    expect(op!.entity.variableName).toBe("Tasks")
    expect(op!.type).toBe("query")
    expect(op!.indexName).toBe("byUser")
  })

  it("should detect Users.scan() operation", () => {
    const source = `Users.scan()`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 6, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("scan")
  })

  it("should return undefined for non-entity calls", () => {
    const source = `console.log("hello")`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 8, entities)

    expect(op).toBeUndefined()
  })

  it("should return undefined for unknown entity names", () => {
    const source = `Products.get({ productId: "p-1" })`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 9, entities)

    expect(op).toBeUndefined()
  })

  it("should handle numeric argument values", () => {
    const source = `Tasks.put({ taskId: "t-1", userId: "u-1", priority: 3 })`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 6, entities)

    expect(op).toBeDefined()
    expect(op!.arguments?.priority).toBe(3)
  })

  it("should detect db.Users.get() via typed client", () => {
    const source = `db.Users.get({ userId: "u-alice" })`
    const sf = parseSource(source)
    // Position on "get" — after "db.Users."
    const op = detectOperation(ts, sf, 9, entities)

    expect(op).toBeDefined()
    expect(op!.entity.variableName).toBe("Users")
    expect(op!.type).toBe("get")
    expect(op!.arguments).toEqual({ userId: "u-alice" })
  })

  it("should detect db.Tasks.put() via typed client", () => {
    const source = `db.Tasks.put({ taskId: "t-1", userId: "u-1", title: "Test", status: "todo", priority: 1 })`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 9, entities)

    expect(op).toBeDefined()
    expect(op!.entity.variableName).toBe("Tasks")
    expect(op!.type).toBe("put")
  })

  it("should detect db.Users.update() via typed client", () => {
    const source = `db.Users.update({ userId: "u-alice" })`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 9, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("update")
  })

  it("should detect db.Users.scan() via typed client", () => {
    const source = `db.Users.scan()`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 9, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("scan")
  })

  it("should detect db.Users.collect(Users.query.byRole(...)) as query", () => {
    const source = `db.Users.collect(Users.query.byRole({ role: "admin" }))`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 9, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("query")
    expect(op!.indexName).toBe("byRole")
    expect(op!.arguments).toEqual({ role: "admin" })
  })

  it("should detect db.Tasks.paginate(Tasks.query.byUser(...)) as query", () => {
    const source = `db.Tasks.paginate(Tasks.query.byUser({ userId: "u-1" }))`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 9, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("query")
    expect(op!.indexName).toBe("byUser")
    expect(op!.arguments).toEqual({ userId: "u-1" })
  })

  it("should detect db.Users.collect(Users.scan()) as scan", () => {
    const source = `db.Users.collect(Users.scan())`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 9, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("scan")
  })

  it("should detect db.Users.paginate(Users.scan()) as scan", () => {
    const source = `db.Users.paginate(Users.scan())`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 9, entities)

    expect(op).toBeDefined()
    expect(op!.type).toBe("scan")
  })

  // --- V2 patterns ---

  const mockCollection: ResolvedCollection = {
    variableName: "TasksByUser",
    collectionName: "tasksByUser",
    index: "gsi1",
    type: "clustered",
    pk: { field: "gsi1pk", composite: ["userId"] },
    sk: { field: "gsi1sk" },
    members: {
      Tasks: { entityVariableName: "Tasks", sk: { composite: ["status", "taskId"] } },
    },
  }

  const assignmentsCollection: ResolvedCollection = {
    variableName: "Assignments",
    collectionName: "assignments",
    index: "gsi3",
    type: "clustered",
    pk: { field: "gsi3pk", composite: ["employee"] },
    sk: { field: "gsi3sk" },
    members: {
      Employees: { entityVariableName: "Users", sk: { composite: [] } },
      Tasks: { entityVariableName: "Tasks", sk: { composite: ["project", "task"] } },
    },
  }

  const collections = [mockCollection, assignmentsCollection]

  it("should detect db.entities.Tasks.tasksByUser(...) as entity-query-accessor", () => {
    const source = `db.entities.Tasks.tasksByUser({ userId: "u-1" })`
    const sf = parseSource(source)
    // Position on "tasksByUser" (18..29)
    const op = detectOperation(ts, sf, 22, entities, collections)

    expect(op).toBeDefined()
    expect(op!.type).toBe("entity-query-accessor")
    expect(op!.entity?.variableName).toBe("Tasks")
    expect(op!.collectionName).toBe("tasksByUser")
  })

  it("should detect db.collections.Assignments(...) as collection-accessor", () => {
    const source = `db.collections.Assignments({ employee: "dfinlay" })`
    const sf = parseSource(source)
    // Position on "Assignments" (15..26)
    const op = detectOperation(ts, sf, 18, entities, collections)

    expect(op).toBeDefined()
    expect(op!.type).toBe("collection-accessor")
    expect(op!.collectionName).toBe("assignments")
  })

  it("should detect .collect() on entity query accessor as bound-query-terminal", () => {
    const source = `db.entities.Tasks.tasksByUser({ userId: "u-1" }).collect()`
    const sf = parseSource(source)
    // Position on "collect" (49..56)
    const op = detectOperation(ts, sf, 50, entities, collections)

    expect(op).toBeDefined()
    expect(op!.type).toBe("bound-query-terminal")
    expect(op!.terminalName).toBe("collect")
    expect(op!.entity?.variableName).toBe("Tasks")
  })

  it("should detect db.entities.Tasks.scan() via v2 path", () => {
    const source = `db.entities.Tasks.scan()`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 19, entities, collections)

    expect(op).toBeDefined()
    expect(op!.type).toBe("scan")
    expect(op!.entity?.variableName).toBe("Tasks")
  })

  it("should detect db.tables.HrTable as table-accessor", () => {
    const source = `db.tables.HrTable`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 11, entities, collections)

    expect(op).toBeDefined()
    expect(op!.type).toBe("table-accessor")
    expect(op!.tableName).toBe("HrTable")
  })

  it("should detect db.entities.Users.get via v2 entities namespace", () => {
    const source = `db.entities.Users.get({ userId: "u-1" })`
    const sf = parseSource(source)
    const op = detectOperation(ts, sf, 19, entities, collections)

    expect(op).toBeDefined()
    expect(op!.type).toBe("get")
    expect(op!.entity?.variableName).toBe("Users")
  })
})
