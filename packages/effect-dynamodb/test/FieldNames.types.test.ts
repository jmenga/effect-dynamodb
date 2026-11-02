/**
 * Definition attribute names typed from the model, at the runtime package's
 * own definition APIs: the operational `Entity.make` and `Aggregate.make`, and
 * `Collections.member` / `Collections.make` (not in the barrel; imported directly). A positive case and a typo case
 * (`@ts-expect-error`) per position; the runtime checks stay for untyped
 * callers. (The pure-package positions are covered in
 * `packages/schema/test/FieldNames.types.test.ts`.)
 */
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Collections from "../src/Collections.js"
import { Aggregate, DynamoModel, DynamoSchema, Entity, Table } from "../src/index.js"

const AppSchema = DynamoSchema.make({ name: "fieldnames", version: 1 })

class Employee extends Schema.Class<Employee>("Employee")({
  employee: Schema.String,
  office: Schema.String,
  name: Schema.String,
}) {}

class Task extends Schema.Class<Task>("Task")({
  task: Schema.String,
  project: Schema.String,
  employee: Schema.String,
  status: Schema.Literals(["open", "done"]),
}) {}

const Employees = Entity.make({
  model: Employee,
  entityType: "Employee",
  primaryKey: {
    pk: { field: "pk", composite: ["employee"] },
    sk: { field: "sk", composite: [] },
  },
})

const Tasks = Entity.make({
  model: Task,
  entityType: "Task",
  primaryKey: {
    pk: { field: "pk", composite: ["task"] },
    sk: { field: "sk", composite: [] },
  },
  indexes: {
    byProject: {
      name: "gsi1",
      pk: { field: "gsi1pk", composite: ["project"] },
      sk: {
        field: "gsi1sk",
        zorder: ["status", { field: "employee", bytes: 2 }],
      },
    },
  },
})

const MainTable = Table.make({ schema: AppSchema, entities: { Employees, Tasks } })

describe("definition attribute names are typed from the model (runtime package)", () => {
  it("Entity.make: composites and Z-order entries", () => {
    expect(Tasks.indexes.byProject.sk.composite).toEqual(["status", "employee"])
    expect(() =>
      Entity.make({
        model: Task,
        entityType: "Task",
        primaryKey: {
          pk: { field: "pk", composite: ["task"] },
          sk: { field: "sk", composite: [] },
        },
        indexes: {
          byProject: {
            name: "gsi1",
            // @ts-expect-error not a model field
            pk: { field: "gsi1pk", composite: ["projct"] },
            sk: {
              field: "gsi1sk",
              zorder: [
                // @ts-expect-error not a model field
                "statsu",
              ],
            },
          },
        },
      }),
    ).toThrow(/EDD-9002/)
  })

  it("Collections.member: SK composites of the member's model", () => {
    Collections.member(Tasks, ["project", "task"])
    // @ts-expect-error not a field of Task
    expect(() => Collections.member(Tasks, ["projet"])).not.toThrow()
  })

  it("Collections.make: PK composites every member has", () => {
    Collections.make({
      name: "assignments",
      index: { name: "gsi3", pk: "gsi3pk", sk: "gsi3sk" },
      composite: ["employee"],
      members: {
        Employees: Collections.member(Employees, []),
        Tasks: Collections.member(Tasks, ["project", "task"]),
      },
    })
    expect(() =>
      Collections.make({
        name: "assignments",
        index: { name: "gsi3", pk: "gsi3pk", sk: "gsi3sk" },
        // @ts-expect-error `office` is an Employee field, not a Task one
        composite: ["office"],
        members: {
          Employees: Collections.member(Employees, []),
          Tasks: Collections.member(Tasks, ["project", "task"]),
        },
      }),
    ).toThrow(/Attribute 'office' not found on Task model/)
  })

  describe("Aggregate.make", () => {
    class Official extends Schema.Class<Official>("Official")({
      officialId: Schema.String,
      name: Schema.String,
    }) {}
    const Officials = Entity.make({
      model: DynamoModel.configure(Official, { officialId: { identifier: true } }),
      entityType: "Official",
      primaryKey: {
        pk: { field: "pk", composite: ["officialId"] },
        sk: { field: "sk", composite: [] },
      },
    })
    class Appointment extends Schema.Class<Appointment>("Appointment")({
      official: Official,
      role: Schema.Literals(["onfield", "third"]),
    }) {}
    class Match extends Schema.Class<Match>("Match")({
      matchId: Schema.String,
      season: Schema.String,
      venue: Schema.String,
      officials: Schema.Array(Appointment),
    }) {}

    it("pk, list and context composites, edge keys and many sk paths", () => {
      Aggregate.make(Match, {
        table: MainTable,
        schema: AppSchema,
        pk: { field: "pk", composite: ["matchId"] },
        collection: { name: "match" },
        list: {
          index: "gsi1",
          name: "matches",
          pk: { field: "gsi1pk", composite: ["season"] },
          sk: { field: "gsi1sk", composite: ["matchId"] },
        },
        context: ["venue"],
        root: { entityType: "MatchItem" },
        edges: {
          officials: Aggregate.many("officials", {
            entityType: "MatchOfficial",
            entity: Officials,
            sk: { composite: ["role", "official.officialId"] },
          }),
        },
      })
    })

    it("a misspelled name in each position", () => {
      const typeOnly = (_: () => unknown) => undefined
      typeOnly(() =>
        Aggregate.make(Match, {
          table: MainTable,
          schema: AppSchema,
          // @ts-expect-error not a schema field
          pk: { field: "pk", composite: ["matchIdd"] },
          collection: { name: "match" },
          root: { entityType: "MatchItem" },
          edges: {},
        }),
      )
      typeOnly(() =>
        Aggregate.make(Match, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["matchId"] },
          collection: { name: "match" },
          list: {
            index: "gsi1",
            name: "matches",
            // @ts-expect-error not a schema field
            pk: { field: "gsi1pk", composite: ["seasn"] },
            sk: { field: "gsi1sk", composite: ["matchId"] },
          },
          root: { entityType: "MatchItem" },
          edges: {},
        }),
      )
      typeOnly(() =>
        Aggregate.make(Match, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["matchId"] },
          collection: { name: "match" },
          root: { entityType: "MatchItem" },
          edges: {
            officials: Aggregate.many("officials", {
              entityType: "MatchOfficial",
              entity: Officials,
              sk: { composite: ["role"] },
            }),
            // @ts-expect-error not a schema field
            refereee: Aggregate.one("referee", { entityType: "MatchReferee", entity: Officials }),
          },
        }),
      )
      typeOnly(() =>
        Aggregate.make(Appointment, {
          root: { entityType: "AppointmentItem" },
          edges: {
            // @ts-expect-error not a schema field (sub-aggregate form)
            oficial: Aggregate.one("official", { entityType: "Appointee", entity: Officials }),
          },
        }),
      )
      typeOnly(() =>
        Aggregate.make(Match, {
          table: MainTable,
          schema: AppSchema,
          pk: { field: "pk", composite: ["matchId"] },
          collection: { name: "match" },
          root: { entityType: "MatchItem" },
          edges: {
            // @ts-expect-error "official.officialID" is not a path of the element
            officials: Aggregate.many("officials", {
              entityType: "MatchOfficial",
              entity: Officials,
              sk: { composite: ["official.officialID"] },
            }),
          },
        }),
      )
    })
  })
})
