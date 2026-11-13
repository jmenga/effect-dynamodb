---
---

Chore: wait on the committed checkpoint in the change-feed restart test, make the in-memory test tables answer the requests the library sends as DynamoDB Local does, apart from the differences listed in one place, and fail by name on anything else they don't model (checked against DynamoDB Local by a connected conformance suite), check the sparse-entry operations' requests against the published 1.40.0, split the connected sparse-entry and sort-key escaping tests into tests that fit their time budget, fail on tests that build an Effect and never run it, in the forms the test file itself proves, and document how to cap vitest's workers. No version change.
