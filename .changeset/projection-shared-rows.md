---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Projections sharing an outbox (#237). `drainPending` on an outbox index shared by read models of one entity type drains only its own read model's items, and leaves the others' unclaimed for their drainers (1.39.0 and 1.40.0 claimed them and failed, leaving them claimed). `EventStore.processBatch` runs a projection object built by hand, carrying the routes but not the read model, as 1.39.0 did, instead of dying with a `TypeError`. The shared outbox key space check (`EDD-9134`) no longer refuses two layouts 1.39.0 handled: at bind, a date composite is taken as the text its encoding writes (an ISO date or instant, or a number), so a read model keyed by a date beside one keyed by a label the date's text can't spell binds; and the outbox table's `rekey` compares a member keyed as a read model by the kind of each composite, so a literal union where the read model has a string moves its items where the read model reads them.
