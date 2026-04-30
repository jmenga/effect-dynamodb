---
"effect-dynamodb": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

`Entity.append()` (time-series): refactor to a fluent `BoundAppend` builder, surface stale outcomes on the Effect error channel, and add `.skipFollowUp()` (closes #33).

Breaking changes (pre-1.0; minor bump per lockstep convention):

- `db.entities.X.append(input)` now returns a fluent `BoundAppend` builder (matching `BoundPut`/`BoundUpdate`/`BoundDelete`) instead of a plain `Effect`. Yield it directly in `Effect.gen`, or call `.asEffect()` to convert.
- The `AppendResult<Model>` discriminated union (`{ applied: true, current } | { applied: false, reason: "stale", current }`) is removed. Successful appends return `{ readonly current: Model }` directly. Stale outcomes now fail the Effect with the new `StaleAppend` tagged error (carrying `current: Option<unknown>`). User-supplied `.condition(...)` rejections (when CAS held) fail with the existing `ConditionalCheckFailed`, augmented with optional `current: Option<unknown>` to carry the live state for reconciliation.

New:

- `.skipFollowUp()` on `BoundAppend` suppresses the post-transaction `GetItem` for high-volume ingest paths. Success narrows to `void`; CAS / user-condition rejections collapse into `StaleAppend(current: Option.none())` because no follow-up GetItem runs to disambiguate.
- `.condition(callback | shorthand)` is now a fluent combinator on `BoundAppend` (previously a positional arg).

Migration:

```ts
// Before
const r = yield* db.entities.Telemetry.append(input)
if (r.applied) { use(r.current) } else { /* stale */ }

// After (default path)
const { current } = yield* db.entities.Telemetry.append(input).pipe(
  Effect.catchTag("StaleAppend", (e) => /* e.current is Option<unknown> */ Effect.succeed(...)),
)

// After (fire-and-forget)
yield* db.entities.Telemetry.append(input)
  .skipFollowUp()
  .pipe(Effect.catchTag("StaleAppend", () => Effect.void))
```

This supersedes the v1 stale-as-value decision in `docs/designs/timeseries.md` §4.7 — see the revised section in that doc for the full rationale.
