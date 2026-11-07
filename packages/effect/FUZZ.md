# Fuzzing with `Fuzz`

`Arbitrary.checkEffect` runs a property on a fixed number of random inputs. `Fuzz` runs the same property for as long
as you let it, and learns: it keeps inputs that made the program do something new, mutates them, and saves every
distinct failure so it replays as an ordinary test.

```
seed ─► pick a kept input ─► mutate its random tape ─► generate the value ─► run the property
                                                                                │
  kept inputs ◄── new feedback (spans, causes, observations, scores) ◄──────────┤
                                                                                │
                               failure ─► save ─► shrink (same signature) ─► save the shrunk value
```

## When to use it

Use `checkEffect` (or `it.effect.prop`) for laws that random inputs exercise well. Use `Fuzz` when a failure hides
behind conditions that random inputs almost never satisfy together: a magic number, a protocol prefix, a state reached
after a precise sequence of commands, or a fiber interleaving.

The test suite in `test/fuzz/Fuzz.benchmark.test.ts` has a parser with a four-byte magic number. `checkEffect` passes
it after 100,000 runs with seed 1; `Fuzz.run` with seed 1 finds the crash at execution 197,163, guided only by the
`Effect.fn` spans the parser already has.

## A first run

```ts
import { Arbitrary, Effect, Fuzz, Schema } from "effect"

const Byte = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))

const report = yield* Fuzz.run(Arbitrary.schema(Schema.Array(Byte)), (bytes) => parse(bytes).pipe(Effect.as(true)), {
  seed: 1,
  executions: 500_000
})
if (report._tag === "Falsified") console.log(Fuzz.formatReport(report))
```

The property contract is the one of `checkEffect`: return `true` (or an Effect of `true`) to pass. Returning anything
else, failing, or **dying** is a finding. Unlike `checkEffect`, a defect raised by the property is a finding (`Died`),
because a crash is what fuzzing looks for. Interruption propagates.

A run stops at the first of `duration` (default 10 seconds when no budget is given), `executions`, `plateau`
(executions without new feedback) and `maxFindings` distinct failures (default 1).

## What guides the search

| Source         | What it records                                                                                   | Setup                                      |
| -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `spans`        | `(parent span, span)` for every span started, so `Effect.fn("Bank.withdraw")` is a coverage point | on by default; `feedback: []` turns it off |
| `causes`       | the exit tag, each error `_tag`, each defect constructor                                          | always                                     |
| `observations` | each `Fuzz.observe(label)`                                                                        | call it where reaching a stage matters     |
| scores         | `Fuzz.score(label, value)`, maximized per label                                                   | call it to climb toward a goal             |
| `structural`   | header and tape-length buckets                                                                    | always                                     |
| injected       | any `Fuzz.Feedback`, such as V8 coverage                                                          | `feedback: [...]`                          |

`Fuzz.observe` and `Fuzz.score` do nothing outside a fuzz execution, so they can stay in production code.

`stats.features` counts features per source. A report whose only sources are `structural` and `causes` says
"structural exploration": nothing measured code coverage, and the search explored generator choices blindly.

```ts
// A score turns a needle into a hill: the fuzzer finds n === 777_777_777 in a billion values.
Fuzz.run(wide, (n) => Effect.as(Fuzz.score("closeness", -Math.abs(n - 777_777_777)), n !== 777_777_777))
```

## Findings

Each finding has a `signature`: `ReturnedFalse`, `PropertyError:<tag>`, `Died:<constructor>` or `Deadlock`. The tag is
the error's `_tag`, else its constructor name. Findings with the same signature are one finding. Shrinking uses the
existing Arbitrary shrink trees and accepts a smaller input only if it keeps the signature, so a `Bust` failure never
shrinks into a `Boom`.

`finding.replay` is a `fuzz1:` token: the generator tape, the schedule tape and the shrink path. Pass it back to
reproduce the finding:

```ts
Fuzz.run(arbitrary, property, { replay: finding.replay })
// Falsified while the bug exists, Passed once it is fixed.
```

## Keeping what it finds

`Fuzz.run` keeps its corpus in memory. To keep failures between runs, give the property a stable identity with
`Fuzz.target` and provide a store:

```ts
const target = Fuzz.target(Schema.Array(Byte), (bytes) => parse(bytes).pipe(Effect.as(true)), {
  id: "container/parse",
  revision: "1"
})
Fuzz.runTarget(target, { duration: "1 minute" }).pipe(Effect.provideService(Fuzz.Corpus, store))
```

A store saves two kinds of entries:

- **Failures are values.** A failure is saved before shrinking and saved again with the shrunk value. When the target
  was built from a Schema, the value is encoded with `Schema.toCodecJson`, and it replays forever, whatever happens to
  the generator. Pass `codec` to `Fuzz.target` to save values of a plain Arbitrary.
- **Inputs are a search cache.** They are generator tapes, tied to `revision`. Change `revision` when the Arbitrary
  changes; saved tapes of another revision are skipped and counted in `stats.stale`. A failure without a codec is also
  a tape, and the report says it will not survive a generator change.

`runTarget` with `executions: 0` only replays saved failures: the regression mode used by test runners.

## `@effect/vitest`

```ts
import { it } from "@effect/vitest"

it.effect.fuzz(
  "parse never dies",
  [Schema.Array(Byte)],
  ([bytes]) =>
    parse(bytes).pipe(Effect.catchTag(["NotAContainer", "TooShort"], () => Effect.succeed(0)), Effect.as(true))
)
```

A plain `vitest run` replays every saved failure of the test, which must now pass, then checks 100 random inputs like
`it.effect.prop`. It writes nothing and takes as long as a property test.

A fuzz session searches and saves:

```sh
EFFECT_FUZZ="parse never dies" EFFECT_FUZZ_DURATION="60 seconds" EFFECT_FUZZ_SEED=1 vitest run container.test.ts
```

`EFFECT_FUZZ` selects tests whose name contains it, or every fuzz test when it is `1`. `EFFECT_FUZZ_EXECUTIONS` bounds
the session by executions instead. A session raises the test timeout to the duration plus 30 seconds. A finding fails
the test with the shrunk input, the signature and the replay token, and is saved to
`__fuzz__/<test file>/<test name>/<key>` beside the test file: commit that directory. Search inputs go to
`node_modules/.cache/effect-fuzz`.

After the fix, the plain run prints `Replayed 1 saved failure(s) of Container > parse never dies` and passes. The test
in `packages/vitest/test/fuzz-example.test.ts` is this workflow, with its saved failure committed.

`it.fuzz` is the synchronous form. Options: `id` (default: the test's full name), `revision` (default `"1"`), `fuzz`
(search options for sessions), and the usual Vitest options.

## Determinism and its limits

For a seed, execution `k` is the same on every machine: the fuzzer's own random source chooses inputs and mutations,
and `duration` only decides how many executions happen. A property that reads `Date.now`, `Math.random`, real I/O or
shared mutable state breaks this, exactly as it breaks `checkEffect` replay.

## Design notes

- **The input is the random tape.** Every generator draws its randomness through one `GenerationRandom`. Fuzzing
  replaces it with a tape of 32-bit words and mutates the words (random, boundary values, arithmetic, bit flips, block
  zero/delete/insert/duplicate, splices) and the header (`size`, numeric bias, null-prototype records). Changing a
  union's choice word reinterprets the rest of the tape, which is a structural mutation for free. Words past the end of
  a tape are a pure function of the tape key and position, so `flatMap` checkpoints and lazy shrink pulls replay.
- **No second generator model.** Every Arbitrary is fuzzable unchanged, including `map`, `filter`, `filterMap`,
  `flatMap`, recursion and records. A test pins that the same tape gives the same value with and without shrink trees.
- **Energy follows rarity.** A parent is chosen by the rarity of the rarest feature it owns (AFL++'s "fast" schedule);
  the best entry for each score has top energy. One in four parents is uniform, one in eight inputs is fresh.
- **Infrastructure errors are not findings.** A dying generator, feedback source, store, codec or execution driver is a
  `FuzzError`.
- **`checkEffect` is untouched.** `Fuzz` lives in its own module with its own evaluation and shrink walk, so ordinary
  property checks pay nothing.
- **Left out on purpose:** per-execution timeouts (cooperative interruption cannot stop synchronous code), tape-level
  shrinking of values (the shrink trees already do it), corpus merge and minimization, parallel executions inside one
  run, and comparison-operand feedback.
