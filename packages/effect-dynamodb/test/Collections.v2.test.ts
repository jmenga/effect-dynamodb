import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import * as Collections from "../src/Collections.js"

// ---------------------------------------------------------------------------
// Test models and entities
// ---------------------------------------------------------------------------

class EmployeeModel extends Schema.Class<EmployeeModel>("EmployeeModel")({
  employee: Schema.String,
  team: Schema.String,
  title: Schema.String,
  salary: Schema.Number,
}) {}

class TaskModel extends Schema.Class<TaskModel>("TaskModel")({
  employee: Schema.String,
  project: Schema.String,
  task: Schema.String,
  status: Schema.String,
}) {}

class ProjectModel extends Schema.Class<ProjectModel>("ProjectModel")({
  project: Schema.String,
  name: Schema.String,
  budget: Schema.Number,
}) {}

/** Helper to create a minimal CollectionEntityLike mock. */
const makeEntityLike = (
  model: Schema.Top,
  entityType: string,
): Collections.CollectionEntityLike => ({
  _tag: "Entity" as const,
  model,
  entityType,
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["employee"] },
      sk: { field: "sk", composite: [] },
    },
  },
  schemas: { recordSchema: model as Schema.Codec<any> },
})

const Employees = makeEntityLike(EmployeeModel, "Employee")
const Tasks = makeEntityLike(TaskModel, "Task")
const _Projects = makeEntityLike(ProjectModel, "Project")

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Collections.make", () => {
  // -----------------------------------------------------------------------
  // Basic creation
  // -----------------------------------------------------------------------

  describe("basic creation", () => {
    it("returns correct shape with _tag, name, index, pk, sk, type, members", () => {
      const Assignments = Collections.make({
        name: "assignments",
        index: { name: "gsi3", pk: "gsi3pk", sk: "gsi3sk" },
        composite: ["employee"],
        members: {
          Employees: Collections.member(Employees, []),
          Tasks: Collections.member(Tasks, ["project", "task"]),
        },
      })

      expect(Assignments._tag).toBe("Collection")
      expect(Assignments.name).toBe("assignments")
      expect(Assignments.index).toEqual({ name: "gsi3", pk: "gsi3pk", sk: "gsi3sk" })
      expect(Assignments.composite).toEqual(["employee"])
      expect(Assignments.members.Employees).toBeDefined()
      expect(Assignments.members.Tasks).toBeDefined()
    })

    it("preserves member entity references", () => {
      const col = Collections.make({
        name: "test",
        index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
        composite: ["employee"],
        members: {
          Employees: Collections.member(Employees, []),
        },
      })

      expect(col.members.Employees.entity).toBe(Employees)
    })

    it("preserves member SK composites", () => {
      const col = Collections.make({
        name: "test",
        index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
        composite: ["employee"],
        members: {
          Tasks: Collections.member(Tasks, ["project", "task"]),
        },
      })

      expect(col.members.Tasks.sk).toEqual(["project", "task"])
    })
  })

  // -----------------------------------------------------------------------
  // Default type is "isolated"
  // -----------------------------------------------------------------------

  describe("isolated default", () => {
    it("defaults type to isolated when not specified", () => {
      const col = Collections.make({
        name: "myCol",
        index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
        composite: ["employee"],
        members: {
          Employees: Collections.member(Employees, []),
        },
      })

      expect(col.type).toBe("isolated")
    })
  })

  // -----------------------------------------------------------------------
  // Isolated type
  // -----------------------------------------------------------------------

  describe("isolated type", () => {
    it("preserves type: isolated when explicitly set", () => {
      const col = Collections.make({
        name: "myCol",
        index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
        composite: ["employee"],
        type: "isolated",
        members: {
          Employees: Collections.member(Employees, []),
        },
      })

      expect(col.type).toBe("isolated")
    })
  })

  // -----------------------------------------------------------------------
  // Validation: empty members
  // -----------------------------------------------------------------------

  describe("validation: empty members", () => {
    it("throws when members record is empty", () => {
      expect(() =>
        Collections.make({
          name: "empty",
          index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
          composite: ["employee"],
          members: {},
        }),
      ).toThrow("requires at least 1 member")
    })
  })

  // -----------------------------------------------------------------------
  // Validation: duplicate entity types
  // -----------------------------------------------------------------------

  describe("validation: duplicate entity types", () => {
    it("throws when the same entityType appears in multiple members", () => {
      const EmployeesAlias = makeEntityLike(EmployeeModel, "Employee")

      expect(() =>
        Collections.make({
          name: "dups",
          index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
          composite: ["employee"],
          members: {
            A: Collections.member(Employees, []),
            B: Collections.member(EmployeesAlias, []),
          },
        }),
      ).toThrow("Entity type 'Employee' appears in multiple members")
    })
  })

  // -----------------------------------------------------------------------
  // Validation: invalid PK composite
  // -----------------------------------------------------------------------

  describe("validation: invalid PK composite", () => {
    it("throws when PK attribute does not exist on model", () => {
      expect(() =>
        Collections.make({
          name: "badPk",
          index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
          composite: ["nonExistentField"],
          members: {
            Employees: Collections.member(Employees, []),
          },
        }),
      ).toThrow("Attribute 'nonExistentField' not found on Employee model")
    })
  })

  // -----------------------------------------------------------------------
  // Validation: invalid SK composite
  // -----------------------------------------------------------------------

  describe("validation: invalid SK composite", () => {
    it("throws when SK attribute does not exist on model", () => {
      expect(() =>
        Collections.make({
          name: "badSk",
          index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
          composite: ["employee"],
          members: {
            Employees: Collections.member(Employees, ["employee", "missingField"]),
          },
        }),
      ).toThrow("Attribute 'missingField' not found on Employee model")
    })
  })

  // -----------------------------------------------------------------------
  // Validation: includes member name in error
  // -----------------------------------------------------------------------

  describe("validation: error message includes context", () => {
    it("error includes collection name and member name", () => {
      expect(() =>
        Collections.make({
          name: "myCollection",
          index: { name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" },
          composite: ["bogus"],
          members: {
            MyMember: Collections.member(Tasks, []),
          },
        }),
      ).toThrow("collection 'myCollection', member 'MyMember'")
    })
  })
})

// ---------------------------------------------------------------------------
// Collections.member
// ---------------------------------------------------------------------------

describe("Collections.member", () => {
  it("returns a CollectionMember with correct _tag", () => {
    const m = Collections.member(Employees, ["team"])
    expect(m._tag).toBe("CollectionMember")
  })

  it("carries entity and SK config", () => {
    const m = Collections.member(Tasks, ["project", "task"])
    expect(m.entity).toBe(Tasks)
    expect(m.sk).toEqual(["project", "task"])
  })
})
