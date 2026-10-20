---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

An append can now seal its stream, and it can carry another stream's append in its transaction (#166). Without the new options, appends behave as before.

- **`append(..., { seal: true })`** makes the append's last event the stream's final event. A later append fails with the new `StreamSealed` error (`streamName`, `streamId`, `sealedVersion`), which is exported from `effect-dynamodb` and `@effect-dynamodb/schema`.
  - The library marks the sealing event's item, and the append's inline snapshot, with `__edd_sealed__`. The existing contiguity check now also tests that marker. The failure is diagnosed from the cancellation reasons, so the seal costs no extra items, no extra capacity and no pre-read.
  - `seal` with zero events, or a `seal` that is not a boolean, fails with `ValidationError`. On a `mode: "inline"` stream without `every`, a sealing append also needs `snapshot`.
  - `StreamSealed` is terminal. `commandHandler` never retries it, and it reports the seal from its load, before `decide`. With `loadState`, the handler learns of the seal from `LoadedState.sealedVersion`.
- **`stream.appendOp(...)`** returns another stream's append as an item of `append`'s or a handler's `additionalItems`. The item commits if and only if the outer append does. With `seal: true`, one transaction seals a stream and opens its successor (a generation changeover). Without `seal`, several streams' events commit together or not at all. A nested op's failures name its own stream. `Transaction.transactWrite` does not accept it.
- **Reads report the seal.** The sealing event carries `StreamEvent.sealed: true`, and `readLatest` returns it as `LatestState.seal`. A `"withoutMetadata"` stream index does not report it, and neither does `currentVersion`.
- **`commandHandler` retry.** A `VersionConflict` raised by another stream's `appendOp` is now retried, even on a call with an `expectedVersion`. The retry reloads the handler's own stream and checks its If-Match again.
- **Type change.** `append`'s `additionalItems` and `AdditionalItemsInput` widen from `TransactWriteOp` to `AppendWriteOp` (`TransactWriteOp | StreamAppendOp`). Passing a `TransactWriteOp[]` still compiles. Code that reads these types and forwards the value to `Transaction.transactWrite` no longer compiles, so annotate that value as `ReadonlyArray<TransactWriteOp>`.
- **Upgrade every writer before sealing a stream.** A writer on an earlier version doesn't enforce the seal, and one write past the seal reopens the stream for every writer.
- **`writeSnapshot` is unchanged.** It doesn't know whether a stream is sealed, so it must not target a sealed head with an unmarked snapshot. If it does, a `headProof: "snapshot"` append can land past the seal.
