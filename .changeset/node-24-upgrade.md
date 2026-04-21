---
---

Chore: no version change. Bumps CI/Release/deploy-docs workflows from Node 22 → Node 24 and drops the fragile `Upgrade npm` step in release.yml (Node 24 ships with npm 11.x, which already satisfies Trusted Publishing's >= 11.5.1 requirement).
