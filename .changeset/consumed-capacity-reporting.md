---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Report consumed capacity and request counts for every library operation (#174).

Provide `ConsumedCapacity.layer()` (off by default) and every library operation (`Entity.get`, `Entity.query`, `EventStream.read`, `EventStream.append`, `Batch.write`, `Transaction.transactWrite`, `Aggregate.update`, projections, geo, checkpoint store, …) asks DynamoDB for its `ConsumedCapacity`, sums it over every request it sends, and:

- runs in a span `effect-dynamodb.<operation>` (kind `client`, or `internal` when nested in another operation) carrying `aws.dynamodb.consumed_capacity.total` / `.read` / `.write`, `aws.dynamodb.table_names` and `effect_dynamodb.request_count` (pages, for a read);
- delivers one `OperationReport` per root operation to an optional `onOperation` observer: capacity units (read / write split), requests, requests by command, per-table (and, with `level: "indexes"`, per-index) breakdown, vector bytes, outcome, and the nested library operations it ran. Summing reports never double counts.

`ConsumedCapacity.withOperation` / `withOperationStream` group application work into one report. The instrumentation wraps whatever `DynamoClient` is in context, so decorated and mocked clients are covered. With reporting off no request, response or return type changes and no span is created.

Bind sites no longer capture the tracer's parent span current at bind time: spans of bound operations now parent to the caller's span.
