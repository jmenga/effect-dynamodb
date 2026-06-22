# @effect-dynamodb/schema

The pure, AWS-free schema and relationship-derivation layer of [`effect-dynamodb`](https://www.npmjs.com/package/effect-dynamodb).

[![npm](https://img.shields.io/npm/v/@effect-dynamodb/schema)](https://www.npmjs.com/package/@effect-dynamodb/schema)

This package contains the parts of `effect-dynamodb` that do **not** touch the AWS SDK:

- `DynamoModel` — Schema annotations (`Hidden`, `identifier`, `ref`) and `configure()` field overrides.
- `DynamoSchema` — the application namespace (name + version) used for key prefixing.
- `KeyComposer` — composite key composition from index definitions.
- `Errors` — the tagged error hierarchy.
- `Entity.make` / `Aggregate.make` — **pure definition builders** that derive an entity/aggregate's
  `inputSchema` / `updateSchema` / `createSchema` codecs.

It has **zero dependency on `@aws-sdk/*`** — neither in its runtime import graph nor in its emitted
`.d.ts` surface. Import it when you only need an entity/aggregate's derived schemas (for example, as
HTTP API payload schemas or for validation) without pulling the AWS SDK into your dependency graph or
type surface.

```ts
import { Entity } from "@effect-dynamodb/schema"
import { Schema } from "effect"

class Team extends Schema.Class<Team>("Team")({
  teamId: Schema.String,
  name: Schema.NonEmptyString,
}) {}

const Teams = Entity.make({
  model: Team,
  entityType: "Team",
  primaryKey: {
    pk: { field: "pk", composite: ["teamId"] },
    sk: { field: "sk", composite: [] },
  },
})

// The derived, fully-typed input schema — no AWS SDK in sight.
type TeamInput = typeof Teams.inputSchema.Type
```

## Relationship to `effect-dynamodb`

The full [`effect-dynamodb`](https://www.npmjs.com/package/effect-dynamodb) package **depends on and
re-exports** everything here, then adds the AWS runtime (DynamoClient, CRUD/query operations,
Batch/Transaction/Collection, Marshaller). If you need to actually read from or write to DynamoDB, use
`effect-dynamodb` — `import { Entity, Aggregate, DynamoModel, DynamoSchema } from "effect-dynamodb"`
gives you the same definition builders **plus** the operational layer.

## License

MIT
