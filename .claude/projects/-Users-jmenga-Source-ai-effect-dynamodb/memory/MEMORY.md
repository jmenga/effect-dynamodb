# Effect-DynamoDB Project Memory

## Docs Package (`packages/docs/`)
- Astro + Starlight + Tailwind v4 + React + Pagefind
- GitHub Pages config: `base: "/effect-dynamodb"`, `site` is placeholder
- Build: `pnpm --filter @effect-dynamodb/docs build`
- Dev: `pnpm --filter @effect-dynamodb/docs dev`
- E2E: `pnpm --filter @effect-dynamodb/docs test:e2e` (Playwright, chromium)
- Playground uses pure React hooks (not Effect Atom yet)
- All URLs must include `/effect-dynamodb` base path in tests
- Preview server on port 4399 for E2E tests
- Biome excludes `packages/docs/**` (see biome.json `files.ignore`)

## Content Pages (17 total)
- Landing, Getting Started, 8 Guides (Modeling, Indexes, Queries, Data Integrity, Lifecycle, Aggregates, Geospatial, Advanced)
- Tutorial: Cricket Match Manager
- Reference: API Reference, FAQ, Migration from ElectroDB, ElectroDB Gap Analysis
- Playground (interactive key composition explorer)

## E2E Tests (`packages/docs/e2e/`)
- `navigation.test.ts` — 7 tests (homepage, sidebar, guide/ref/tutorial pages)
- `playground.test.ts` — 11 tests (components, scenarios, reactivity, tabs)
- `search.test.ts` — 1 test (search button)
- Uses `const BASE = "/effect-dynamodb"` in each file for path prefix
