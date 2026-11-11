---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

An aggregate's `create` is typed by what it takes. `Aggregate.create` and `db.aggregates.X.create` took `Record<string, unknown>`, so nothing a caller passed was checked. Their parameter is now derived from the model and the edges (`Aggregate.AggregateCreateInputType`).

The type refuses the inputs that 1.39.0 accepted at compile time and failed on at run time, and takes everything that worked there: each field's domain value or its stored form, an edge's entity by its id or whole, keys the model doesn't declare, and the aggregate's own key composites. Code that passed an input 1.39.0 failed on, such as one without a required edge or a key composite, or a value of another type than its field's, no longer compiles. An input whose static type has a string index signature (`Record<string, unknown>`, parsed JSON, `any`) is taken as it is and judged at run time, as before.

`Aggregate` and `BoundAggregate` gain a fourth type parameter, `TCreate`, defaulting to `any`, so a type written with three arguments still names every aggregate. Types only: no request, stored byte or run-time behaviour changes.
