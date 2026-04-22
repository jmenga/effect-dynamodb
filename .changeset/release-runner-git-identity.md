---
---

Chore: configure git user.email/user.name on the release runner so the aggregate-tag step's `git tag -a` succeeds. The previous run (v1.3.0) published to npm but failed at the aggregate-tag step because annotated tags require a committer identity that `actions/checkout` doesn't set by default. No version change.
