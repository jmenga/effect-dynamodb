---
---

Chore: wait on the committed checkpoint in the change-feed restart test, make the in-memory test tables answer every request as DynamoDB Local does (checked by a connected conformance suite), check the sparse-entry operations' requests against the published 1.40.0, split the connected sparse-entry and sort-key escaping tests into tests that fit their time budget, fail on tests that never run the Effect they build, and document how to cap vitest's workers. No version change.
