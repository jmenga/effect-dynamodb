# Changesets

This directory holds [Changesets](https://github.com/changesets/changesets) — markdown files describing changes that warrant a version bump.

## Workflow

After making changes that should ship in a release, run:

```bash
pnpm changeset
```

You'll be prompted to:

1. Pick the affected package(s) — `effect-dynamodb`, `@effect-dynamodb/geo`, `@effect-dynamodb/language-service`
2. Choose the bump type per package (`patch` / `minor` / `major`)
3. Write a one-line summary

Commit the generated `.changeset/*.md` file with your code changes. CI will reject PRs without a changeset (or an explicit version bump).

When the PR merges to `main`, the version-bump PR is opened automatically by `pnpm version` runs locally, and the release workflow detects new versions in `package.json` and publishes.

See `PUBLISH.md` at the repo root for the full release flow.
