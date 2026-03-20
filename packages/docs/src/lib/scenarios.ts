import type { Casing, IndexDefinition } from "./playground-engine"

export interface FieldDef {
  readonly name: string
  readonly type: "string" | "number" | "boolean"
  readonly defaultValue: string | number | boolean
}

export interface Scenario {
  readonly name: string
  readonly description: string
  readonly schema: { readonly name: string; readonly version: number; readonly casing: Casing }
  readonly entityType: string
  readonly entityVersion: number
  readonly tableName: string
  readonly fields: ReadonlyArray<FieldDef>
  readonly indexes: Record<string, IndexDefinition>
}

export const scenarios: ReadonlyArray<Scenario> = [
  {
    name: "Task Manager",
    description: "Basic single-entity with primary + one GSI",
    schema: { name: "taskapp", version: 1, casing: "lowercase" },
    entityType: "Task",
    entityVersion: 1,
    tableName: "Main",
    fields: [
      { name: "taskId", type: "string", defaultValue: "task-001" },
      { name: "projectId", type: "string", defaultValue: "proj-42" },
      { name: "status", type: "string", defaultValue: "active" },
      { name: "title", type: "string", defaultValue: "Ship v1" },
    ],
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["taskId"] },
        sk: { field: "sk", composite: [] },
      },
      byProject: {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["projectId"] },
        sk: { field: "gsi1sk", composite: ["status"] },
      },
    },
  },
  {
    name: "HR System",
    description: "Multi-index with collection for cross-entity queries",
    schema: { name: "hrapp", version: 1, casing: "lowercase" },
    entityType: "Employee",
    entityVersion: 1,
    tableName: "HRTable",
    fields: [
      { name: "employeeId", type: "string", defaultValue: "emp-100" },
      { name: "tenantId", type: "string", defaultValue: "tenant-acme" },
      { name: "department", type: "string", defaultValue: "engineering" },
      { name: "hireDate", type: "string", defaultValue: "2024-03-15" },
      { name: "email", type: "string", defaultValue: "alice@acme.com" },
    ],
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["employeeId"] },
        sk: { field: "sk", composite: [] },
      },
      byTenant: {
        index: "gsi1",
        collection: "tenantData",
        pk: { field: "gsi1pk", composite: ["tenantId"] },
        sk: { field: "gsi1sk", composite: ["department", "hireDate"] },
      },
      byEmail: {
        index: "gsi2",
        pk: { field: "gsi2pk", composite: ["email"] },
        sk: { field: "gsi2sk", composite: [] },
      },
    },
  },
  {
    name: "E-Commerce",
    description: "GSI overloading with price range and category queries",
    schema: { name: "shop", version: 2, casing: "lowercase" },
    entityType: "Product",
    entityVersion: 1,
    tableName: "ShopTable",
    fields: [
      { name: "productId", type: "string", defaultValue: "prod-abc" },
      { name: "category", type: "string", defaultValue: "electronics" },
      { name: "brand", type: "string", defaultValue: "Acme" },
      { name: "price", type: "number", defaultValue: 299 },
      { name: "name", type: "string", defaultValue: "Widget Pro" },
    ],
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["productId"] },
        sk: { field: "sk", composite: [] },
      },
      byCategory: {
        index: "gsi1",
        pk: { field: "gsi1pk", composite: ["category"] },
        sk: { field: "gsi1sk", composite: ["price"] },
      },
      byBrand: {
        index: "gsi2",
        pk: { field: "gsi2pk", composite: ["brand"] },
        sk: { field: "gsi2sk", composite: ["category"] },
      },
    },
  },
  {
    name: "Cricket Match",
    description: "Complex key patterns with clustered collections",
    schema: { name: "cricket", version: 1, casing: "lowercase" },
    entityType: "Match",
    entityVersion: 1,
    tableName: "CricketTable",
    fields: [
      { name: "matchId", type: "string", defaultValue: "match-2024-01" },
      { name: "tournamentId", type: "string", defaultValue: "ipl-2024" },
      { name: "venue", type: "string", defaultValue: "wankhede" },
      { name: "matchDate", type: "string", defaultValue: "2024-04-12" },
      { name: "status", type: "string", defaultValue: "scheduled" },
    ],
    indexes: {
      primary: {
        pk: { field: "pk", composite: ["matchId"] },
        sk: { field: "sk", composite: [] },
      },
      byTournament: {
        index: "gsi1",
        collection: "tournamentMatches",
        pk: { field: "gsi1pk", composite: ["tournamentId"] },
        sk: { field: "gsi1sk", composite: ["matchDate"] },
      },
      byVenue: {
        index: "gsi2",
        pk: { field: "gsi2pk", composite: ["venue"] },
        sk: { field: "gsi2sk", composite: ["matchDate", "status"] },
      },
    },
  },
]
