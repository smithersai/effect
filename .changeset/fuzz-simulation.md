---
"effect": patch
---

Add `FuzzSimulation` to `effect/testing`. `FuzzSimulation.execution()` runs each `Fuzz` evaluation under a scheduler whose preemption points come from a fuzzed schedule tape and a virtual clock, so lost updates, check-then-act races and deadlocks become reproducible findings with replay tokens. Fuzz parent selection now gives energy only to span, observation and provider features when there are any, which keeps the search on the frontier of the program.
