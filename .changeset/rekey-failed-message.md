---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

`rekey` says why it couldn't move an aggregate. A `failed` conflict's `message` gave only the tag of a decomposition error (`AggregateDecompositionError: `) or a validation error, since neither error has a message of its own. It now gives the decomposition error's reason, such as two edge rows composing one sort key, and the validation error's cause, as an entity's `failed` conflict does.
