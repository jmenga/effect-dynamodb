---
---

Chore: add `issues: write` + `pull-requests: write` permissions and `fetch-depth: 0` + `fetch-tags: true` to the release workflow. The 1.3.1 release exposed two silent failures in the aggregate-tag step: (1) `gh label create` and `gh pr edit --add-label` were unauthorized — both were masked by `|| true` — so the `vX.Y.Z` label was never created and only the triggering PR got (mis-)labeled attempts; (2) `actions/checkout` defaults to a shallow clone with no tags, so `PREV_TAG` resolved to `<none>` and `git log HEAD` saw only the merge commit, missing any other PRs merged in the release window. No version change.
