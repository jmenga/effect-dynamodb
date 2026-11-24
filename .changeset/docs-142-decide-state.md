---
---

Chore: document that `decide` receives the state uncopied, so the evolve-fold contract holds only for a `decide` that leaves it alone, plus the `initialState` getter and fresh-object `loadState` rules (#142). No version change.
