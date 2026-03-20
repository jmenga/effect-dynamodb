/**
 * Version Control Example — Multi-Entity Single-Table Design
 *
 * Adapted from the ElectroDB Version Control example:
 * https://electrodb.dev/en/examples/version-control/
 *
 * Simplified to 4 entities (User, Repository, Issue, PullRequest) covering
 * the most interesting patterns from the original 7-entity model.
 *
 * Demonstrates:
 * - 4 entities in one table with 2 GSIs
 * - 3 cross-entity collection patterns (owned, managed, activity)
 * - Status-based sort key composition for filtered queries
 * - Entity-scoped set() for status updates
 * - Atomic issue + PR creation via Transaction.transactWrite
 * - 8 access patterns with strong assertions
 *
 * Prerequisites:
 *   docker run -p 8000:8000 amazon/dynamodb-local
 *
 * Run:
 *   npx tsx examples/version-control.ts
 */

import { Console, Effect, Layer, Schema } from "effect"
import { DynamoClient } from "../src/DynamoClient.js"
import * as DynamoSchema from "../src/DynamoSchema.js"
import * as Entity from "../src/Entity.js"
import * as Table from "../src/Table.js"
import * as Transaction from "../src/Transaction.js"

// =============================================================================
// 1. Pure domain models — no DynamoDB concepts
// =============================================================================

class User extends Schema.Class<User>("User")({
  username: Schema.String,
  fullName: Schema.String,
  bio: Schema.String,
  location: Schema.String,
}) {}

class Repository extends Schema.Class<Repository>("Repository")({
  repoName: Schema.String,
  repoOwner: Schema.String,
  about: Schema.String,
  description: Schema.String,
  isPrivate: Schema.Boolean,
  defaultBranch: Schema.String,
}) {}

const IssueStatus = { Open: "Open", Closed: "Closed" } as const
const IssueStatusSchema = Schema.Literals(Object.values(IssueStatus))

class Issue extends Schema.Class<Issue>("Issue")({
  issueNumber: Schema.String,
  repoName: Schema.String,
  repoOwner: Schema.String,
  username: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  status: IssueStatusSchema,
}) {}

class PullRequest extends Schema.Class<PullRequest>("PullRequest")({
  pullRequestNumber: Schema.String,
  repoName: Schema.String,
  repoOwner: Schema.String,
  username: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  status: IssueStatusSchema,
}) {}

// =============================================================================
// 2. Schema
// =============================================================================

const VcsSchema = DynamoSchema.make({ name: "vcs", version: 1 })

// =============================================================================
// 3. Entity definitions — pure, no table reference
// =============================================================================

const Users = Entity.make({
  model: User,
  entityType: "User",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["username"] },
      sk: { field: "sk", composite: [] },
    },
    owned: {
      index: "gsi1",
      collection: "owned",
      pk: { field: "gsi1pk", composite: ["username"] },
      sk: { field: "gsi1sk", composite: [] },
    },
  },
  timestamps: true,
})

const Repositories = Entity.make({
  model: Repository,
  entityType: "Repository",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["repoOwner"] },
      sk: { field: "sk", composite: ["repoName"] },
    },
    created: {
      index: "gsi1",
      collection: "owned",
      pk: { field: "gsi1pk", composite: ["repoOwner"] },
      sk: { field: "gsi1sk", composite: ["repoName"] },
    },
    activity: {
      index: "gsi2",
      collection: "activity",
      pk: { field: "gsi2pk", composite: ["repoOwner", "repoName"] },
      sk: { field: "gsi2sk", composite: [] },
    },
  },
  timestamps: true,
})

const Issues = Entity.make({
  model: Issue,
  entityType: "Issue",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["repoOwner", "repoName"] },
      sk: { field: "sk", composite: ["issueNumber"] },
    },
    created: {
      index: "gsi1",
      collection: "managed",
      pk: { field: "gsi1pk", composite: ["username"] },
      sk: { field: "gsi1sk", composite: ["status", "issueNumber"] },
    },
    todos: {
      index: "gsi2",
      collection: "activity",
      pk: { field: "gsi2pk", composite: ["repoOwner", "repoName"] },
      sk: { field: "gsi2sk", composite: ["status", "issueNumber"] },
    },
  },
  timestamps: true,
})

const PullRequests = Entity.make({
  model: PullRequest,
  entityType: "PullRequest",
  indexes: {
    primary: {
      pk: { field: "pk", composite: ["repoOwner", "repoName"] },
      sk: { field: "sk", composite: ["pullRequestNumber"] },
    },
    created: {
      index: "gsi1",
      collection: "managed",
      pk: { field: "gsi1pk", composite: ["username"] },
      sk: { field: "gsi1sk", composite: ["status", "pullRequestNumber"] },
    },
    enhancements: {
      index: "gsi2",
      collection: "activity",
      pk: { field: "gsi2pk", composite: ["repoOwner", "repoName"] },
      sk: { field: "gsi2sk", composite: ["status", "pullRequestNumber"] },
    },
  },
  timestamps: true,
})

// =============================================================================
// 4. Table definition — declares all entities as members
// =============================================================================

const VcsTable = Table.make({
  schema: VcsSchema,
  entities: { Users, Repositories, Issues, PullRequests },
})

// =============================================================================
// 5. Seed data
// =============================================================================

const users = {
  octocat: {
    username: "octocat",
    fullName: "The Octocat",
    bio: "GitHub mascot",
    location: "San Francisco, CA",
  },
  torvalds: {
    username: "torvalds",
    fullName: "Linus Torvalds",
    bio: "Creator of Linux and Git",
    location: "Portland, OR",
  },
} as const

const repos = {
  helloWorld: {
    repoName: "hello-world",
    repoOwner: "octocat",
    about: "My first repository on GitHub!",
    description: "A simple hello world project for learning Git",
    isPrivate: false,
    defaultBranch: "main",
  },
  linux: {
    repoName: "linux",
    repoOwner: "torvalds",
    about: "Linux kernel source tree",
    description: "The Linux kernel",
    isPrivate: false,
    defaultBranch: "master",
  },
} as const

const issues = {
  helloWorldBug: {
    issueNumber: "1",
    repoName: "hello-world",
    repoOwner: "octocat",
    username: "torvalds",
    subject: "Bug: README has typo",
    body: "There is a typo in the README file on line 3.",
    status: "Open" as const,
  },
  helloWorldFeature: {
    issueNumber: "2",
    repoName: "hello-world",
    repoOwner: "octocat",
    username: "octocat",
    subject: "Feature: Add contributing guide",
    body: "We should add a CONTRIBUTING.md file.",
    status: "Closed" as const,
  },
  linuxBug: {
    issueNumber: "1",
    repoName: "linux",
    repoOwner: "torvalds",
    username: "octocat",
    subject: "Bug: Kernel panic on boot",
    body: "Kernel panic when booting with specific hardware configuration.",
    status: "Open" as const,
  },
} as const

const pullRequests = {
  helloWorldPR: {
    pullRequestNumber: "1",
    repoName: "hello-world",
    repoOwner: "octocat",
    username: "torvalds",
    subject: "Fix README typo",
    body: "Fixes the typo mentioned in issue #1.",
    status: "Open" as const,
  },
  linuxPR: {
    pullRequestNumber: "1",
    repoName: "linux",
    repoOwner: "torvalds",
    username: "octocat",
    subject: "Fix boot panic for hardware X",
    body: "Addresses kernel panic on boot with specific hardware.",
    status: "Open" as const,
  },
} as const

// =============================================================================
// 6. Helpers
// =============================================================================

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const assertEq = <T>(actual: T, expected: T, label: string): void => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`Assertion failed [${label}]: expected ${e}, got ${a}`)
}

// =============================================================================
// 7. Main program — 8 access patterns with assertions
// =============================================================================

const program = Effect.gen(function* () {
  // Typed execution gateway — binds all table members
  const db = yield* DynamoClient.make(VcsTable)

  // --- Setup: create table ---
  yield* db.createTable()

  // --- Seed data ---
  for (const user of Object.values(users)) {
    yield* db.Users.put(user)
  }
  for (const repo of Object.values(repos)) {
    yield* db.Repositories.put(repo)
  }
  for (const issue of Object.values(issues)) {
    yield* db.Issues.put(issue)
  }
  for (const pr of Object.values(pullRequests)) {
    yield* db.PullRequests.put(pr)
  }

  // -------------------------------------------------------------------------
  // Pattern 1: Get user profile (primary key)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 1: Get User Profile")

  const octocat = yield* db.Users.get({ username: "octocat" })
  assertEq(octocat.fullName, "The Octocat", "octocat fullName")
  assertEq(octocat.bio, "GitHub mascot", "octocat bio")
  assertEq(octocat.location, "San Francisco, CA", "octocat location")

  const torvalds = yield* db.Users.get({ username: "torvalds" })
  assertEq(torvalds.fullName, "Linus Torvalds", "torvalds fullName")
  assertEq(torvalds.location, "Portland, OR", "torvalds location")
  yield* Console.log("  User profiles: octocat, torvalds — OK")

  // -------------------------------------------------------------------------
  // Pattern 2: Get repository (primary key)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 2: Get Repository")

  const helloWorld = yield* db.Repositories.get({ repoOwner: "octocat", repoName: "hello-world" })
  assertEq(helloWorld.about, "My first repository on GitHub!", "hello-world about")
  assertEq(helloWorld.isPrivate, false, "hello-world isPrivate")
  assertEq(helloWorld.defaultBranch, "main", "hello-world defaultBranch")

  const linux = yield* db.Repositories.get({ repoOwner: "torvalds", repoName: "linux" })
  assertEq(linux.about, "Linux kernel source tree", "linux about")
  assertEq(linux.defaultBranch, "master", "linux defaultBranch")
  yield* Console.log("  Repositories: hello-world, linux — OK")

  // -------------------------------------------------------------------------
  // Pattern 3: User's owned repos (gsi1 — "owned" collection)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 3: User's Owned Repos (gsi1 collection)")

  const octocatRepos = yield* db.Repositories.collect(
    Repositories.query.created({ repoOwner: "octocat" }),
  )
  assertEq(octocatRepos.length, 1, "octocat has 1 repo")
  assertEq(octocatRepos[0]!.repoName, "hello-world", "octocat repo name")

  const torvaldsRepos = yield* db.Repositories.collect(
    Repositories.query.created({ repoOwner: "torvalds" }),
  )
  assertEq(torvaldsRepos.length, 1, "torvalds has 1 repo")
  assertEq(torvaldsRepos[0]!.repoName, "linux", "torvalds repo name")

  const octocatProfile = yield* db.Users.collect(Users.query.owned({ username: "octocat" }))
  assertEq(octocatProfile.length, 1, "owned collection returns 1 user")
  assertEq(octocatProfile[0]!.fullName, "The Octocat", "owned user fullName")
  yield* Console.log("  Owned repos: octocat (1), torvalds (1) — OK")

  // -------------------------------------------------------------------------
  // Pattern 4: Create issue + update status
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 4: Create Issue + Update Status")

  const newIssue = yield* db.Issues.put({
    issueNumber: "3",
    repoName: "hello-world",
    repoOwner: "octocat",
    username: "torvalds",
    subject: "Enhancement: Add CI pipeline",
    body: "We should add GitHub Actions for CI/CD.",
    status: "Open",
  })
  assertEq(newIssue.issueNumber, "3", "new issue number")
  assertEq(newIssue.status, "Open", "new issue status")

  const closedIssue = yield* db.Issues.update(
    { repoOwner: "octocat", repoName: "hello-world", issueNumber: "3" },
    Entity.set({ status: "Closed", username: "torvalds" }),
  )
  assertEq(closedIssue.status, "Closed", "closed issue status")
  assertEq(closedIssue.subject, "Enhancement: Add CI pipeline", "closed issue preserves subject")
  yield* Console.log("  Create + close issue #3 — OK")

  // -------------------------------------------------------------------------
  // Pattern 5: Create pull request + close it
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 5: Create Pull Request + Close")

  const newPR = yield* db.PullRequests.put({
    pullRequestNumber: "2",
    repoName: "hello-world",
    repoOwner: "octocat",
    username: "octocat",
    subject: "Add CONTRIBUTING.md",
    body: "Adds a contributing guide as requested in issue #2.",
    status: "Open",
  })
  assertEq(newPR.pullRequestNumber, "2", "new PR number")
  assertEq(newPR.status, "Open", "new PR status")

  const closedPR = yield* db.PullRequests.update(
    { repoOwner: "octocat", repoName: "hello-world", pullRequestNumber: "2" },
    Entity.set({ status: "Closed", username: "octocat" }),
  )
  assertEq(closedPR.status, "Closed", "closed PR status")
  assertEq(closedPR.subject, "Add CONTRIBUTING.md", "closed PR preserves subject")
  yield* Console.log("  Create + close PR #2 — OK")

  // -------------------------------------------------------------------------
  // Pattern 6: User's issues and PRs (gsi1 — "managed" collection)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 6: User's Managed Items (gsi1 collection)")

  const torvaldsIssues = yield* db.Issues.collect(Issues.query.created({ username: "torvalds" }))
  assertEq(torvaldsIssues.length, 2, "torvalds has 2 issues")
  const torvaldsIssueSubjects = torvaldsIssues.map((i) => i.subject).sort()
  assert(
    torvaldsIssueSubjects.some((s) => s.includes("README has typo")),
    "torvalds has typo issue",
  )
  assert(
    torvaldsIssueSubjects.some((s) => s.includes("CI pipeline")),
    "torvalds has CI issue",
  )

  const torvaldsPRs = yield* db.PullRequests.collect(
    PullRequests.query.created({ username: "torvalds" }),
  )
  assertEq(torvaldsPRs.length, 1, "torvalds has 1 PR")
  assertEq(torvaldsPRs[0]!.subject, "Fix README typo", "torvalds PR subject")

  const octocatIssues = yield* db.Issues.collect(Issues.query.created({ username: "octocat" }))
  assertEq(octocatIssues.length, 2, "octocat has 2 issues")

  const octocatPRs = yield* db.PullRequests.collect(
    PullRequests.query.created({ username: "octocat" }),
  )
  assertEq(octocatPRs.length, 2, "octocat has 2 PRs")
  yield* Console.log("  Managed items: torvalds (2 issues, 1 PR), octocat (2 issues, 2 PRs) — OK")

  // -------------------------------------------------------------------------
  // Pattern 7: Repository activity — issues + PRs (gsi2 — "activity" collection)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 7: Repository Activity (gsi2 collection)")

  const hwIssues = yield* db.Issues.collect(
    Issues.query.todos({ repoOwner: "octocat", repoName: "hello-world" }),
  )
  assertEq(hwIssues.length, 3, "hello-world has 3 issues")
  const hwOpenIssues = hwIssues.filter((i) => i.status === "Open")
  assertEq(hwOpenIssues.length, 1, "hello-world has 1 open issue")
  assertEq(hwOpenIssues[0]!.issueNumber, "1", "open issue is #1")
  const hwClosedIssues = hwIssues.filter((i) => i.status === "Closed")
  assertEq(hwClosedIssues.length, 2, "hello-world has 2 closed issues")

  const hwPRs = yield* db.PullRequests.collect(
    PullRequests.query.enhancements({ repoOwner: "octocat", repoName: "hello-world" }),
  )
  assertEq(hwPRs.length, 2, "hello-world has 2 PRs")
  const hwOpenPRs = hwPRs.filter((pr) => pr.status === "Open")
  assertEq(hwOpenPRs.length, 1, "hello-world has 1 open PR")
  const hwClosedPRs = hwPRs.filter((pr) => pr.status === "Closed")
  assertEq(hwClosedPRs.length, 1, "hello-world has 1 closed PR")

  const linuxIssues = yield* db.Issues.collect(
    Issues.query.todos({ repoOwner: "torvalds", repoName: "linux" }),
  )
  assertEq(linuxIssues.length, 1, "linux has 1 issue")
  assertEq(linuxIssues[0]!.status, "Open", "linux issue is Open")

  const linuxPRs = yield* db.PullRequests.collect(
    PullRequests.query.enhancements({ repoOwner: "torvalds", repoName: "linux" }),
  )
  assertEq(linuxPRs.length, 1, "linux has 1 PR")
  assertEq(linuxPRs[0]!.status, "Open", "linux PR is Open")

  const hwRepoActivity = yield* db.Repositories.collect(
    Repositories.query.activity({ repoOwner: "octocat", repoName: "hello-world" }),
  )
  assertEq(hwRepoActivity.length, 1, "activity returns 1 repo record")
  assertEq(hwRepoActivity[0]!.repoName, "hello-world", "activity repo name")
  yield* Console.log("  Activity: hello-world (3 issues, 2 PRs), linux (1 issue, 1 PR) — OK")

  // -------------------------------------------------------------------------
  // Pattern 8: Atomic create — issue + PR together (Transaction)
  // -------------------------------------------------------------------------
  yield* Console.log("Pattern 8: Atomic Create (Transaction)")

  yield* Transaction.transactWrite([
    Issues.put({
      issueNumber: "2",
      repoName: "linux",
      repoOwner: "torvalds",
      username: "torvalds",
      subject: "Track: Memory leak in driver",
      body: "Tracking issue for the memory leak fix.",
      status: "Open",
    }),
    PullRequests.put({
      pullRequestNumber: "2",
      repoName: "linux",
      repoOwner: "torvalds",
      username: "torvalds",
      subject: "Fix memory leak in driver X",
      body: "Fixes the memory leak described in issue #2.",
      status: "Open",
    }),
  ])

  const txIssue = yield* db.Issues.get({
    repoOwner: "torvalds",
    repoName: "linux",
    issueNumber: "2",
  })
  assertEq(txIssue.subject, "Track: Memory leak in driver", "transaction issue subject")
  assertEq(txIssue.status, "Open", "transaction issue status")

  const txPR = yield* db.PullRequests.get({
    repoOwner: "torvalds",
    repoName: "linux",
    pullRequestNumber: "2",
  })
  assertEq(txPR.subject, "Fix memory leak in driver X", "transaction PR subject")
  assertEq(txPR.status, "Open", "transaction PR status")

  const linuxIssuesAfter = yield* db.Issues.collect(
    Issues.query.todos({ repoOwner: "torvalds", repoName: "linux" }),
  )
  assertEq(linuxIssuesAfter.length, 2, "linux now has 2 issues")

  const linuxPRsAfter = yield* db.PullRequests.collect(
    PullRequests.query.enhancements({ repoOwner: "torvalds", repoName: "linux" }),
  )
  assertEq(linuxPRsAfter.length, 2, "linux now has 2 PRs")
  yield* Console.log("  Atomic create: issue #2 + PR #2 on linux — OK")

  // --- Cleanup ---
  yield* db.deleteTable
  yield* Console.log("\nAll 8 patterns passed.")
})

// =============================================================================
// 8. Provide dependencies and run
// =============================================================================

const AppLayer = Layer.mergeAll(
  DynamoClient.layer({
    region: "us-east-1",
    endpoint: "http://localhost:8000",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  }),
  VcsTable.layer({ name: "vcs-table" }),
)

const main = program.pipe(Effect.provide(AppLayer))

Effect.runPromise(main).then(
  () => console.log("\nDone."),
  (err) => console.error("\nFailed:", err),
)

export {
  program,
  VcsTable,
  VcsSchema,
  Users,
  Repositories,
  Issues,
  PullRequests,
  User,
  Repository,
  Issue,
  PullRequest,
}
