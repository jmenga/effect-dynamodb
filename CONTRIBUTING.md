# Contributing to effect-dynamodb

## Prerequisites

- Node.js 18+
- pnpm 9+
- Docker (for running examples against DynamoDB Local)

## Setup

```bash
git clone https://github.com/your-org/effect-dynamodb.git
cd effect-dynamodb
pnpm install
```

## Commands

```bash
pnpm build        # TypeScript compilation (tsc)
pnpm test         # Run all tests (vitest run)
pnpm test:watch   # Watch mode (vitest)
pnpm check        # Type check without emit (tsc --noEmit)
pnpm lint         # Lint + format check (biome check)
pnpm lint:fix     # Auto-fix lint + format issues (biome check --write)
```

## Project Structure

```
src/
├── DynamoModel.ts      # Immutable field annotation
├── DynamoSchema.ts     # Application namespace and key prefixing
├── Table.ts            # Table definition with Layer-based name injection
├── Entity.ts           # Model-to-table binding, CRUD, queries, lifecycle
├── Query.ts            # Pipeable Query<A> data type
├── Collection.ts       # Multi-entity queries
├── Transaction.ts      # Atomic multi-item operations
├── Batch.ts            # Batch get/write with auto-chunking
├── Expression.ts       # Condition, filter, update expression builders
├── Projection.ts       # ProjectionExpression builder
├── KeyComposer.ts      # Composite key composition
├── Marshaller.ts       # DynamoDB marshal/unmarshal wrapper
├── DynamoClient.ts     # Effect Service wrapping AWS SDK
├── Errors.ts           # Tagged error types
└── index.ts            # Public API barrel export

test/                   # Mirrors src/ — one test file per module
examples/               # Runnable examples (require DynamoDB Local)
docs/                   # User-facing documentation guides
```

## Testing

Unit tests use mocked `DynamoClient` — no external infrastructure required:

```bash
pnpm test
```

Examples run against DynamoDB Local:

```bash
docker run -p 8000:8000 amazon/dynamodb-local
npx tsx examples/starter.ts
```

## Code Conventions

- **Strict TypeScript** — `strict: true`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- **ESM only** — `"type": "module"` with NodeNext resolution
- **Biome** for linting and formatting — run `pnpm lint:fix` before committing
- **Effect patterns** — Tagged errors (`Data.TaggedError`), `ServiceMap.Service` for services, `Function.dual` for public APIs
- **Barrel exports** — `src/index.ts` is the sole public entry point

## Pull Request Guidelines

1. Run `pnpm lint && pnpm check && pnpm test` before submitting
2. Add tests for new functionality
3. Update documentation in `docs/` if the change affects the public API
4. Keep PRs focused — one feature or fix per PR
