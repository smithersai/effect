---
"effect": patch
"@effect/vitest": patch
---

Keep confirmed Fuzz findings after flaky candidates, retain distinct regression fixtures, and fall back to generator tapes when a codec cannot encode a finding. Persist new failures only after shrinking and confirmation. Report wholly discarded searches as `Exhausted`, non-regenerating tokens as `ReplayMismatch`, and incomplete simulation cleanup as an execution error.
