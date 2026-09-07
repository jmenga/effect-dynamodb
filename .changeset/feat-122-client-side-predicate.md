---
"effect-dynamodb": minor
"@effect-dynamodb/schema": minor
"@effect-dynamodb/geo": minor
"@effect-dynamodb/language-service": minor
---

Add `.filterBy()` — a client-side predicate that takes part in `limit` and cursor rebuilding

`limit` is a contract on **results**: the request loop accumulates until `n` items are accepted and rebuilds the cursor from the last accepted item. Only a `FilterExpression` could take part in that, so a predicate DynamoDB cannot express had to be applied after the query returned — which breaks pagination two ways. The page comes back short, and its cursor resumes after the last item *returned* rather than the last one *kept*, so the next page skips rows. `Page<A>` exposes one page-level cursor and no per-item resume token, so a caller filtering externally could not construct a correct resume point at all.

The motivating case is case-insensitive matching. DynamoDB has no `lower()`, so a `FilterExpression` compares the stored attribute byte-for-byte:

```ts
// stored: name = "Melbourne Cricket Ground"
.filter((t, { beginsWith }) => beginsWith(t.name, "melbourne"))   // no match
.filterBy((v) => v.name.toLowerCase().startsWith("melbourne"))    // matches
```

Composite **keys** never had this problem — `applyCasing` folds both the stored key and the operand — but a sort key is one string, so its members are only usable as a contiguous leading prefix. "As much as the key prefix can take, the rest matched case-insensitively" was not expressible without dropping to the raw SDK and reimplementing the accumulate-and-rebuild loop.

Added on `Query`, `BoundQuery` and `Aggregate.list`'s `ListOptions` (as `filterBy`), so there is one vocabulary rather than three. On an aggregate it runs on the root item **before assembly**, for the same reason `ListOptions.filter` is worth pushing server-side: a rejected root item never pays for its partition read.

Two corners are closed rather than left to be discovered:

- **`.count()`** would have reported the unfiltered count, since `Select: "COUNT"` returns no items to run the predicate against. It now reads the rows and counts the accepted ones — correct, at the cost of the read. Its error channel gains `ValidationError` accordingly, since decoding can now fail during a count.
- **`.select()` with a predicate** raises **EDD-9054**. A projection returns only the attributes it names, and a predicate is an opaque closure whose attribute reads the library cannot see — so it cannot borrow them into the `ProjectionExpression` the way key attributes are borrowed for cursor rebuilding, and the predicate would be handed items missing the fields it tests.

Prefer `.filter()` whenever DynamoDB can express the condition: a `FilterExpression` rejects rows before they cross the wire, while this runs after decode, so every examined row is still read and paid for.

Collection queries (`db.collections.*`) are unchanged — their result is a per-entity grouping rather than a single item stream, so a per-item predicate has no single shape there.
