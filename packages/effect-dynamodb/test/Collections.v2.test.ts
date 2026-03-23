import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import * as Collections from "../src/Collections.js"
import type { IndexDefinition } from "../src/KeyComposer.js"

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
const Projects = makeEntityLike(ProjectModel, "Project")

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Collections.make", () => {
  // -----------------------------------------------------------------------
  // Basic creation
  // -----------------------------------------------------------------------

  describe("basic creation", () => {
    it("returns correct shape with _tag, name, index, pk, sk, type, members", () => {
      const Assignments = Collections.make("assignments", {
        index: "gsi3",
        pk: { field: "gsi3pk", composite: ["employee"] },
        sk: { field: "gsi3sk" },
        members: {
          Employees: Collections.member(Employees, { sk: { composite: [] } }),
          Tasks: Collections.member(Tasks, { sk: { composite: ["project", "task"] } }),
        },
      })

      expect(Assignments._tag).toBe("Collection")
      expect(Assignments.name).toBe("assignments")
      expect(Assignments.index).toBe("gsi3")
      expect(Assignments.pk).toEqual({ field: "gsi3pk", composite: ["employee"] })
      expect(Assignments.sk).toEqual({ field: "gsi3sk" })
      expect(Assignments.members.Employees).toBeDefined()
      expect(Assignments.members.Tasks).toBeDefined()
    })

    it("preserves member entity references", () => {
      const col = Collections.make("test", {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["employee"] },
        sk: { field: "gsi1sk" },
        members: {
          Employees: Collections.member(Employees, { sk: { composite: [] } }),
        },
      })

      expect(col.members.Employees.entity).toBe(Employees)
    })

    it("preserves member SK composites", () => {
      const col = Collections.make("test", {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["employee"] },
        sk: { field: "gsi1sk" },
        members: {
          Tasks: Collections.member(Tasks, { sk: { composite: ["project", "task"] } }),
        },
      })

      expect(col.members.Tasks.sk.composite).toEqual(["project", "task"])
    })
  })

  // -----------------------------------------------------------------------
  // Default type is "clustered"
  // -----------------------------------------------------------------------

  describe("clustered default", () => {
    it("defaults type to clustered when not specified", () => {
      const col = Collections.make("myCol", {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["employee"] },
        sk: { field: "gsi1sk" },
        members: {
          Employees: Collections.member(Employees, { sk: { composite: [] } }),
        },
      })

      expect(col.type).toBe("clustered")
    })
  })

  // -----------------------------------------------------------------------
  // Isolated type
  // -----------------------------------------------------------------------

  describe("isolated type", () => {
    it("preserves type: isolated when explicitly set", () => {
      const col = Collections.make("myCol", {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["employee"] },
        sk: { field: "gsi1sk" },
        type: "isolated",
        members: {
          Employees: Collections.member(Employees, { sk: { composite: [] } }),
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
        Collections.make("empty", {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["employee"] },
          sk: { field: "gsi1sk" },
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
        Collections.make("dups", {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["employee"] },
          sk: { field: "gsi1sk" },
          members: {
            A: Collections.member(Employees, { sk: { composite: [] } }),
            B: Collections.member(EmployeesAlias, { sk: { composite: [] } }),
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
        Collections.make("badPk", {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["nonExistentField"] },
          sk: { field: "gsi1sk" },
          members: {
            Employees: Collections.member(Employees, { sk: { composite: [] } }),
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
        Collections.make("badSk", {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["employee"] },
          sk: { field: "gsi1sk" },
          members: {
            Employees: Collections.member(Employees, {
              sk: { composite: ["employee", "missingField"] },
            }),
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
        Collections.make("myCollection", {
          index: "gsi1",
          pk: { field: "gsi1pk", composite: ["bogus"] },
          sk: { field: "gsi1sk" },
          members: {
            MyMember: Collections.member(Tasks, { sk: { composite: [] } }),
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
    const m = Collections.member(Employees, { sk: { composite: ["team"] } })
    expect(m._tag).toBe("CollectionMember")
  })

  it("carries entity and SK config", () => {
    const m = Collections.member(Tasks, { sk: { composite: ["project", "task"] } })
    expect(m.entity).toBe(Tasks)
    expect(m.sk.composite).toEqual(["project", "task"])
  })
})

// ---------------------------------------------------------------------------
// buildMemberIndexDef
// ---------------------------------------------------------------------------

describe("Collections.buildMemberIndexDef", () => {
  it("builds correct IndexDefinition from collection and member", () => {
    const col = Collections.make("assignments", {
      index: "gsi3",
      pk: { field: "gsi3pk", composite: ["employee"] },
      sk: { field: "gsi3sk" },
      members: {
        Employees: Collections.member(Employees, { sk: { composite: [] } }),
        Tasks: Collections.member(Tasks, { sk: { composite: ["project", "task"] } }),
      },
    })

    const taskMember = col.members.Tasks
    const indexDef = Collections.buildMemberIndexDef(col, "Tasks", taskMember)

    expect(indexDef.index).toBe("gsi3")
    expect(indexDef.collection).toBe("assignments")
    expect(indexDef.type).toBe("clustered")
    expect(indexDef.pk).toEqual({ field: "gsi3pk", composite: ["employee"] })
    expect(indexDef.sk).toEqual({ field: "gsi3sk", composite: ["project", "task"] })
  })

  it("builds IndexDefinition with empty SK composites", () => {
    const col = Collections.make("byTeam", {
      index: "gsi2",
      pk: { field: "gsi2pk", composite: ["team"] },
      sk: { field: "gsi2sk" },
      members: {
        Employees: Collections.member(Employees, { sk: { composite: [] } }),
      },
    })

    const empMember = col.members.Employees
    const indexDef = Collections.buildMemberIndexDef(col, "Employees", empMember)

    expect(indexDef.sk).toEqual({ field: "gsi2sk", composite: [] })
  })

  it("preserves isolated type in IndexDefinition", () => {
    const col = Collections.make("isolated", {
      index: "gsi4",
      pk: { field: "gsi4pk", composite: ["employee"] },
      sk: { field: "gsi4sk" },
      type: "isolated",
      members: {
        Tasks: Collections.member(Tasks, { sk: { composite: ["project"] } }),
      },
    })

    const indexDef = Collections.buildMemberIndexDef(col, "Tasks", col.members.Tasks)
    expect(indexDef.type).toBe("isolated")
  })

  it("SK composites are a new array (not shared reference)", () => {
    const taskMember = Collections.member(Tasks, { sk: { composite: ["project", "task"] } })
    const col = Collections.make("test", {
      index: "gsi1",
      pk: { field: "gsi1pk", composite: ["employee"] },
      sk: { field: "gsi1sk" },
      members: { Tasks: taskMember },
    })

    const indexDef = Collections.buildMemberIndexDef(col, "Tasks", taskMember)
    // Should be equal in value
    expect(indexDef.sk.composite).toEqual(["project", "task"])
    // But not the same array reference (spread creates new array)
    expect(indexDef.sk.composite).not.toBe(taskMember.sk.composite)
  })
})
