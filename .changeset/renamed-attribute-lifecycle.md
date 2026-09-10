---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Fix the lifecycle paths that read a stored row by domain field name (#127)

A row read back from DynamoDB is keyed by its **stored attribute** name, but key
composition and unique-sentinel composition name **domain** fields. Under a
`DynamoModel.configure(Model, { id: { field: "widgetId" } })` rename the two
differ, and two families of bugs followed.

**Soft-delete reads and `restore`** never applied `renameFromDynamo`:
`deleted.get` and `deleted.list` decoded an attribute-keyed row against the
domain-keyed `deletedRecordSchema` and failed with
`ValidationError` ("Missing key"), while `restore` composed keys from it and died
with a **defect** out of `KeyComposer.extractComposites`. Any entity with both
`softDelete` and a renamed field could write a tombstone it could never read back
or undo.

**Unique-sentinel composition** read the constraint field off the raw row at five
call sites — soft delete, hard delete, `restore`, `purge`, and the
`transactWrite` put-expansion (`Entity._buildPutSideItems`). A renamed field read
as `undefined`, which the sparse rule treats as "constraint unset", so the
sentinel was silently skipped: deletes orphaned the sentinel (making the value
unusable forever), `restore` re-established nothing (allowing duplicates), and a
put issued through `transactWrite` enforced no uniqueness at all.

Every one of those sites now composes from a domain-keyed view of the row; the
item written back stays attribute-keyed.
