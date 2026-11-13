---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

**`UniqueConstraintViolation.fields`, `DeleteAppliedButUnreadable.item`, and `current` on `ConditionalCheckFailed`, `ConcurrentModification` and `StaleAppend` are left out of the error's `toJSON`, so `JSON.stringify(error)`, `inspect(error)` and Effect's built-in log formats no longer show them.** `fields` holds the caller's values, a `Schema.RedactedFromValue` field's plaintext among them, and the others hold a whole stored item. A log line that showed which value broke a unique constraint now shows the constraint's name only. **Code that sends an error as JSON (`JSON.stringify(error)`) no longer sends these fields: send a copy (`JSON.stringify({ ...error })`) or the field itself.** Nothing else changes: code reads the fields (`error.fields.email`), and a copy (`{ ...error }`, `Object.assign`), `Object.keys`, `Equal.equals` and test equality (`toEqual`) include them, as they did. A logger of your own that reads an error's properties, instead of its `toJSON`, still sees them.
