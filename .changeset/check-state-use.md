---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Check that `decide` leaves its state alone: `commandHandler({ checkStateUse: true })` (#290).

- With the option on (meant for tests), a `decide` that changes the state it was given fails the command with a defect, `EDD-9183`, naming the stream, the command and the first changed path, for example `at innings[1].overs (was 3, now 4)`. It covers every state `decide` is given: a stream load, a snapshot (verified or not), a `loadState` record and the initial state. Nothing is appended, and the defect is not retried.
- A shared `initialState` (a value, not a getter) that changes during a command is a defect too, `EDD-9184`. An in-place `evolve` does this whenever a fold starts from it, on load or when the new events are folded. The message says to declare `initialState` as a getter.
- A state is compared as the stream's snapshot schema would store it when there is one, and field by field otherwise: `Map`, `Set`, `HashMap`, `HashSet` and `Chunk` by their contents, and `Date`, `DateTime`, `BigDecimal`, `Option` and `Result` by value. Reading a value in `decide` (formatting a `DateTime`, normalizing a `BigDecimal`) is not a change. The check writes nothing and calls no getter, so a frozen state works, and an object the state reaches by two paths is compared once.
- Off by default, and then the handler runs exactly as before: no copy, no fingerprint. Whether state may be mutated stays the application's decision; the option is a way to enforce the contract where the application wants it.
