# Publishing

This monorepo ships three packages to npm:

| Package | Path |
|---|---|
| `effect-dynamodb` | `packages/effect-dynamodb` |
| `@effect-dynamodb/geo` | `packages/effect-dynamodb-geo` |
| `@effect-dynamodb/language-service` | `packages/language-service` |

`@effect-dynamodb/docs` and `@effect-dynamodb/doctest` are private and never published.

Versioning uses [Changesets](https://github.com/changesets/changesets); publishing and GitHub releases run automatically on push to `main` via `.github/workflows/release.yml`. Documentation deploys to GitHub Pages via `.github/workflows/deploy-docs.yml`.

Authentication to npm uses [**Trusted Publishing**](https://docs.npmjs.com/trusted-publishers) — short-lived OIDC tokens minted per-run by GitHub Actions. There is no `NPM_TOKEN` secret to manage or rotate.

## Day-to-day flow

1. **Make changes** on a feature branch.
2. **Add a changeset** describing what changed:

   ```bash
   pnpm changeset
   ```

   Pick the affected package(s), bump type (patch/minor/major), and write a one-line summary. Commit the generated `.changeset/*.md` file.

3. **Open a PR.** CI runs lint, typecheck, tests, build, and verifies a changeset (or version bump) is present.
4. **Merge.** Nothing is published yet — the changeset just describes intent.
5. **Bump versions** by running locally on `main` (or in a follow-up PR):

   ```bash
   git checkout main && git pull
   pnpm version          # consumes changesets, bumps package.json files, updates CHANGELOG.md
   git add -A && git commit -m "chore: version packages"
   git push
   ```

6. **Release workflow detects new versions** on the `main` push: for each publishable package, it compares `package.json` version to the `latest` tag on npm. Any package with a new version is built, tested, published with `--provenance --access public`, and tagged as `<pkg-name>@<version>` with a GitHub release.

## Manual publishing (if needed)

Local publishing still uses interactive `npm login` (with 2FA OTP) — Trusted Publishing is CI-only.

```bash
npm login                  # one-time, with 2FA
pnpm version               # consume changesets, bump versions
git add -A && git commit -m "chore: version packages"
pnpm release               # build + changeset publish
git push --follow-tags
```

## GitHub setup (one-time)

### 1. Create the npm organization

The `@effect-dynamodb` npm scope must be created and owned by your npm account:

1. Sign in at https://www.npmjs.com/login (account: `jmenga`).
2. Visit https://www.npmjs.com/org/create and create the org named **`effect-dynamodb`**.
3. Choose the free public-only plan.

The unscoped `effect-dynamodb` package publishes from your personal account; no extra setup needed.

### 2. Configure Trusted Publishers on each package

Trusted Publishing is configured per-package on npm. You can configure it before the package exists — npm allows pre-registering a package name with a trusted publisher, so the very first publish works too.

For each of the three packages:

1. Go to https://www.npmjs.com/package/<package-name>/access (or, for a not-yet-existing package, your account → Packages → "Configure trusted publisher for a new package").
2. Under **Trusted publishers**, click **GitHub Actions**.
3. Fill in:

   | Field | Value |
   |---|---|
   | Organization or user | `jmenga` |
   | Repository | `effect-dynamodb` |
   | Workflow filename | `release.yml` |
   | Environment | *(leave blank)* |

4. Save.

Repeat for `effect-dynamodb`, `@effect-dynamodb/geo`, and `@effect-dynamodb/language-service`.

> **No NPM_TOKEN secret is needed.** The release workflow already has `id-token: write` permission and uses the npm CLI's built-in OIDC flow.

### 3. Workflow permissions

Repo → **Settings → Actions → General**:

- **Workflow permissions:** Read and write
- **Allow GitHub Actions to create and approve pull requests:** checked

These let the release workflow create tags + releases and let any future automation open PRs. (`id-token: write` for OIDC is granted per-job in the workflow file itself.)

### 4. Enable GitHub Pages

Repo → **Settings → Pages**:

- **Source:** GitHub Actions

The first push to `main` that touches `packages/docs/**` (or any of the source paths in `deploy-docs.yml`) will trigger a deploy. The site lands at:

> https://jmenga.github.io/effect-dynamodb/

`packages/docs/astro.config.mjs` already sets `site: "https://jmenga.github.io"` and `base: "/effect-dynamodb"`, so all internal links resolve correctly under the subpath.

### 5. Branch protection (recommended)

Repo → **Settings → Branches → Add rule** for `main`:

- Require pull request reviews before merging
- Require status checks to pass — select the **Typecheck, Lint, Test, Build** check
- Require linear history (optional but tidy with version-bump commits)

### 6. Initial publish

After steps 1–4 are done, the very first publish flow:

1. **Pre-register the package names** as trusted publishers (step 2 above) — npm lets you do this for packages that don't yet exist.
2. **Push to `main`.** The release workflow detects that the workspace has version `0.1.0` while npm has nothing (`npm view ... version` returns no result, treated as "0.0.0"), so it publishes all three packages.

No version bump or changeset is required for the first release.

For subsequent releases, follow the day-to-day flow above.

## Troubleshooting

**`npm error 401 EOTP` or `npm error need_auth`:** Trusted Publishing isn't configured for the package on npm. Visit `https://www.npmjs.com/package/<name>/access` and add the GitHub Actions trusted publisher.

**`npm error 422 Unprocessable Entity` on first publish:** The trusted publisher entry on npm may be missing the workflow filename or have a typo. Confirm `release.yml` matches exactly.

**Local `pnpm release` fails with auth error:** Run `npm login` and complete the 2FA challenge. Local publishing doesn't use Trusted Publishing; it uses your interactive npm session.

**Workflow logs show `npm: command not found` for newer flags:** The `Upgrade npm` step in `release.yml` ensures npm ≥ 11.5.1 (Trusted Publishing requires this). If it's missing, restore that step.
