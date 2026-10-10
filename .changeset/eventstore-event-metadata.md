---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

EventStore per-event metadata on `append` and `commandHandler`, and a client-side 400 KB item check (#144)

`append`'s `metadata` is one value copied onto every event of the append. Metadata that belongs to one event (an event id used as a publish message id, the id of an imported event in the store it came from) had nowhere to go but a list packed into that value, so every item stored every entry: N² entries for an append of N events, copied again by any stream index. Everything below is additive; no option combination that works today changes behaviour.

- **`eventMetadata` on `append`.** One entry per event, in the order of `events`: entry `i` is written onto event `i` and read back as that event's `StreamEvent.metadata`. Each defined entry is encoded through the stream's metadata schema, as `metadata` is, and an encode failure names its index (`operation: "EventStore.append.eventMetadata[<i>]"`). An `undefined` entry writes its event without a `metadata` attribute. A length that differs from `events.length` fails with `ValidationError` before anything is sent, even for an append of no events. The read side is unchanged.
- **`eventMetadata` on `commandHandler`.** A function of the `Decision` (`{ events, state, previous, version }`, as a function-form `additionalItems` receives) returning the entries, or an `Effect` of them whose error and requirements join the handler's. It runs after the new events are folded and before `additionalItems`, is not called on a no-op, and is re-run on every attempt (each `VersionConflict` retry and the re-decision under `verifySnapshot: false`). A result of the wrong length fails with `ValidationError` (`operation: "EventStore.commandHandler.eventMetadata"`); neither that nor a failure of the returned `Effect` is retried. Minting ids through `Clock` / `Random` keeps them deterministic under `TestClock` and a seeded `Random`.
- **`metadata` and `eventMetadata` are mutually exclusive**, on `append`, the bound stream and the handler. Passing both is a type error, and a `ValidationError` for untyped callers. `undefined` counts as absent, so `{ metadata: undefined, eventMetadata: [...] }` is accepted.
- **400 KB per item, checked before sending.** A transaction holding an item over DynamoDB's 400 KB item limit (409,600 bytes) now fails with a `ValidationError` naming the item and its key (for an append, e.g. "the event at version 2"), instead of DynamoDB's bare `ValidationException`. The size is a lower bound by DynamoDB's item-size rules, so an item DynamoDB would accept is never refused. The check is shared, so `Transaction.transactWrite` gains it too; those transactions already failed, only the error improves.

Type-level notes:

- `AppendOptions`, `CommandOptions` and `IdempotentCommandOptions` are now type aliases (an intersection with a union, which is how the exclusivity is typed) instead of interfaces. Using them as types is unchanged; an `interface X extends AppendOptions<…>` in user code no longer compiles, since an interface cannot extend a union. New exported types: `AppendOptionsBase`, `AppendMetadataOptions`, `CommandOptionsBase`, `CommandMetadataOptions` and `EventMetadataInput`.
- `CommandHandler` and `BoundCommandHandler` gain two trailing, defaulted type parameters, `E3` and `R3`, for an effectful `eventMetadata`, separate from `additionalItems`' `E2` / `R2` so two effects with different error types are inferred as a union. Call sites infer them; hand-written instantiations keep working.
- `ValidationError` was already in both error channels, so no error union widens.
