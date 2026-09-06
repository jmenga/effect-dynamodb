---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Separate `limit` (results) from `pageSize` (round trips) on queries and scans

`limit` and page size were two different ideas sharing one word. They are now two combinators:

- **`limit(n)`** — return **at most `n` items**. A contract on results. It no longer sets DynamoDB's `Limit`; the query accumulates across as many requests as it takes to reach `n` accepted items or exhaust the key range.
- **`pageSize(n)`** — fetch in **batches of `n` rows**. This is what sets DynamoDB's `Limit` (rows *examined* per request). A contract on round trips, not on what comes back.
- **`maxPages(n)`** — unchanged. Still the hard stop on the number of requests, and the escape hatch when a filter is selective enough that `limit` would otherwise walk a large partition.

Both compose: `.pageSize(50).limit(120)` fetches in requests of at most 50 examined rows, accumulating until 120 items.

**This is why they had to split.** DynamoDB's `Limit` bounds rows *examined*, and a `FilterExpression` is applied *after* it — so `Limit` can never express "give me 3 matching items". Under a filter, `limit` is now satisfied by accumulating across requests; `pageSize` (or an unbounded natural page when unset) is what each request asks for. Every entity query and scan therefore gets correct filtered pagination.

**Cursors.** Once a request can over-read and discard the surplus, `fetch()`'s cursor can no longer be the raw `LastEvaluatedKey` — that points at the last row *examined*, not the last one returned. It is rebuilt from the last item actually handed back (every item carries the table key and the index key), so the next page resumes after what the caller saw. `cursor: null` still means genuinely exhausted. When a `.select()` projection is active alongside a `limit`, the key attributes are added to the request's `ProjectionExpression` and stripped from the items returned, so a truncated page still carries an accurate cursor.

**`count()`.** `limit(n)` caps the count: `.limit(n).count()` returns `min(matching, n)` and stops counting once `n` is reached, keeping `count()` equal to `collect().length` for the same query — and making `.limit(1).count()` a cheap existence check. `pageSize(n)` sizes each `Select: "COUNT"` request.

## Migration — if you used `limit` as a page-size hint, move to `pageSize`

`limit` changes meaning on `collect()` and `paginate()`. The same call keeps compiling and quietly means something else, so check every call site:

| Before | After |
|---|---|
| `.limit(3).collect()` → every item, in pages of 3 | `.limit(3).collect()` → **3 items** |
| `.limit(2).paginate()` → everything, in pages of 2 | `.pageSize(2).paginate()` |
| `.limit(100)` to size a scan's requests | `.pageSize(100)` |
| `.limit(25).fetch()` | unchanged — still up to 25 items and a cursor |

Callers who wrote what the documentation showed (`.limit(3).collect()` for "the first 3") were getting every matching item; they are now correct without a change. This ships as a minor within 1.x rather than waiting for a 2.0 because the old behaviour is a trap the docs already described incorrectly.
