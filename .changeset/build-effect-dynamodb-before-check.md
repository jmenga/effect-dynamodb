---
---

Chore: build `effect-dynamodb` before running `pnpm check` so downstream packages (`@effect-dynamodb/geo`, `@effect-dynamodb/doctest`) can resolve types from `dist/` on a clean checkout. No version change.
