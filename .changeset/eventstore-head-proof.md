---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

An append can now name an item that proves the stream head, in place of the version-contiguity `ConditionCheck`, and `commandHandler` can load state from the caller's own record (#164). Without the new options, nothing changes: every append after version 0 still writes the check.

- **`append({ headProof })`** takes `{ additionalItem: n }` or `"snapshot"` (the `HeadProof` type). The check reads the event at `expectedVersion`, and inside a transaction DynamoDB bills it at 2 WCU per KB of that event; with a proof it is not written.
  - `{ additionalItem: n }`: `additionalItems[n]` is the proof, for example the caller's state record conditioned on the version it was loaded at. It must carry a condition of its own (`.condition()`, `create()` or `Transaction.check`). An item without one, or an `n` that is out of range, fails with `ValidationError` before anything is written. When its condition fails, the append fails with `VersionConflict`, not `AdditionalItemConditionFailed`. Every writer of the stream must write the record in the same transaction as its events.
  - `"snapshot"`: the inline snapshot `Put` is conditioned on `asOfVersion = expectedVersion`, and its failure is a `VersionConflict`. It requires `snapshot` on the append and a `mode: "inline"` stream without `every`; any other snapshot config dies with `[EDD-9085]`.
  - `measureAppend` accepts `headProof` and leaves the check out of `transactionBytes`.
- **`commandHandler({ loadState })`** loads the state and head from the caller's record (`Option` of `LoadedState`: `None` is a new stream) instead of the stream. The If-Match check, `decide` and the append run as before, and a `VersionConflict` re-runs `loadState` under `retry`. Its error and requirements join the handler's.
- **`commandHandler({ headProof })`** applies a head proof to every append the handler makes. With `"snapshot"`, it is applied only when the load found the snapshot at the head; otherwise that append writes the check.
- Creating a handler throws `[EDD-9085]` for `loadState` with `verifySnapshot: false` or with `headProof: "snapshot"`, and for `headProof: "snapshot"` on a stream that is not inline without `every`.
- An inline `loadState: (streamId) => …` is contextually typed by the stream id and the decider's state: the handler's options type parameter no longer has a default.
