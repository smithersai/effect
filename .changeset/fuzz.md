---
"effect": patch
---

Add `Fuzz`, feedback-guided fuzzing over any `Arbitrary`. It mutates the generator's random tape, keeps inputs that produce new span, cause or observation feedback, shrinks each distinct failure with the existing shrink trees, and saves failures to a corpus so they replay as regression tests.

```ts
import { Arbitrary, Effect, Fuzz, Schema } from "effect"

const Int = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))
const report = await Effect.runPromise(
  Fuzz.run(Arbitrary.schema(Schema.Array(Int)), (xs) => !xs.includes(42), { seed: 1, executions: 50_000 })
)
report._tag // "Falsified", shrunk to [42]
```
