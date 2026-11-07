---
"@effect/vitest": patch
---

Add `it.effect.fuzz` and `it.fuzz`. A plain `vitest run` replays every failure a fuzz session saved for the test, then checks random inputs like `it.effect.prop`. Setting `EFFECT_FUZZ=<part of the test name>` (with optional `EFFECT_FUZZ_DURATION`, `EFFECT_FUZZ_EXECUTIONS` and `EFFECT_FUZZ_SEED`) runs a `Fuzz` search instead and saves each finding to `__fuzz__/<test file>/<test name>-<hash>/` beside the test. With `fuzz: { execution: FuzzSimulation.execution() }`, plain runs replay under the simulation, and `it.effect.fuzz` lets it own `Clock` and `Scheduler` instead of `TestClock`.

```ts
it.effect.fuzz("parse never dies", [Schema.Array(Byte)], ([bytes]) => parse(bytes).pipe(Effect.as(true)))
```
