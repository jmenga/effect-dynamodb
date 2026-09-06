---
"effect-dynamodb": patch
"@effect-dynamodb/schema": patch
"@effect-dynamodb/geo": patch
"@effect-dynamodb/language-service": patch
---

Fix `EventStream` variance so the pipeable `commandHandler` form type-checks (#106)

`EventStream`'s operations were declared as function-typed properties, so `strictFunctionTypes` checked their parameters contravariantly. A stream with no `snapshot` config has `TState = never`, and `writeSnapshot(…, state: never, …)` made that stream assignable to no other `EventStream` — not even one instantiated at `any`, since `any` is not assignable to `never`. `append`'s `options?: AppendOptions<TMetadata>` did the same for `TMetadata = undefined`.

The effect: **every data-last / pipeable `commandHandler` call on a snapshot-less stream failed to compile** — `MatchEvents.pipe(EventStore.commandHandler(decider))`, `pipe(MatchEvents, …)` and the `BoundEventStream` equivalents. `pipe` infers its subject from the callback's parameter, erasing the generic function's type parameters to their constraints, which is where the invariance bites. The data-first form (`commandHandler(decider, MatchEvents)`) always worked, which is why this went unnoticed.

`writeSnapshot`, `readSnapshot`, `append`, `read`, `readFrom`, `currentVersion` and `query.events` are now **method** declarations on both `EventStream` and `BoundEventStream`, which makes their parameters bivariant. This is a type-only change with no runtime effect, and supplying a `state` still requires `TState`, so the compile-time guarantee that a snapshot-less stream cannot write a snapshot is unchanged.

One narrowing is lost: `commandHandler`'s `TState extends State` check no longer applies in the *data-last* form. The data-first overloads still enforce it.

Found while making every test file type-checked: `tsconfig.test.json` compiled only four files in `effect-dynamodb` and one in `schema`, and the `geo` and `language-service` packages had no test tsconfig at all. All four now compile their whole `test` directory as part of `pnpm check`, which is what surfaced this. No test assertion changed.
