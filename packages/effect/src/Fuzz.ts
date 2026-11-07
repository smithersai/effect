/**
 * Searches for inputs that falsify a property, guided by feedback, and keeps what it learns.
 *
 * `Fuzz` runs the same `Arbitrary` and the same property as `Arbitrary.checkEffect`, but drives generation from a
 * mutable tape of random words instead of a seed. It keeps tapes that produced new feedback, mutates them, and turns
 * each distinct failure into a shrunk, deduplicated, replayable finding. Feedback is Effect-native: cause shapes, span
 * edges from `Effect.fn` and `Effect.withSpan`, and explicit {@link observe} and {@link score} calls. Platform feedback
 * such as V8 coverage plugs in as a {@link Feedback} value.
 *
 * @stability unstable
 * @since 4.0.0
 */
import * as Arbitrary from "./Arbitrary.ts"
import type * as Arr from "./Array.ts"
import * as Cause from "./Cause.ts"
import type * as Context from "./Context.ts"
import type * as Duration from "./Duration.ts"
import type * as Effect from "./Effect.ts"
import type * as Exit from "./Exit.ts"
import * as Formatter from "./Formatter.ts"
import * as Internal from "./internal/fuzz/engine.ts"
import * as Schema from "./Schema.ts"
import type * as Types from "./Types.ts"

/**
 * Represents a property and the identity under which a corpus stores what fuzzing learns about it.
 *
 * **When to use**
 *
 * Use with {@link runTarget} when saved failures and search inputs must survive between runs. For in-memory fuzzing,
 * {@link run} needs no target.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Target<in out A, out E = never, out R = never> {
  readonly "~effect/Fuzz/Target": "~effect/Fuzz/Target"
  readonly id: string
  readonly revision: string
  readonly "~A": Types.Invariant<A>
  readonly "~E": Types.Covariant<E>
  readonly "~R": Types.Covariant<R>
}

/**
 * Converts generated values to text and back, so a saved failure replays as a value instead of a generator tape.
 *
 * **Details**
 *
 * `id` names the wire format. A saved value with another codec id is a `FuzzError` with reason `"Codec"`, never a
 * silently skipped fixture. `encode` and `decode` are synchronous and may throw; a thrown error is also a `"Codec"`
 * error.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Codec<A> {
  readonly id: string
  readonly encode: (value: A) => string
  readonly decode: (text: string) => A
}

/**
 * Configures a {@link Target}.
 *
 * **Details**
 *
 * `id` is the stable name of the corpus. `revision` declares generator compatibility: change it when the Arbitrary
 * changes, and saved tapes from other revisions stop being replayed. Saved values encoded by `codec` survive every
 * revision.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface TargetOptions<A> {
  readonly id: string
  readonly revision: string
  readonly codec?: Codec<A> | undefined
}

/**
 * Creates a {@link Target} from a Schema or an Arbitrary.
 *
 * **When to use**
 *
 * Use when fuzzing with a corpus store, so findings become regression fixtures.
 *
 * **Details**
 *
 * A Schema input is compiled with `Arbitrary.schema` and gets a value codec from `Schema.toCodecJson` unless
 * `options.codec` is given. An Arbitrary input has no codec unless one is given; its failures are saved as tapes,
 * which replay only while `revision` is unchanged.
 *
 * @stability unstable
 * @category constructors
 * @since 4.0.0
 */
export const target: {
  <S extends Schema.Constraint, E = never, R = never>(
    schema: S,
    property: (value: S["Type"]) => boolean | Effect.Effect<boolean, E, R>,
    options: TargetOptions<S["Type"]>
  ): Target<S["Type"], E, R>
  <A, E = never, R = never>(
    arbitrary: Arbitrary.Arbitrary<A>,
    property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
    options: TargetOptions<A>
  ): Target<A, E, R>
} = (
  input: Schema.Constraint | Arbitrary.Arbitrary<any>,
  property: (value: any) => boolean | Effect.Effect<boolean, any, any>,
  options: TargetOptions<any>
): Target<any, any, any> => {
  if (Arbitrary.isArbitrary(input)) return Internal.makeTarget(input, property, options)
  const schema = input as Schema.Constraint
  const codec = Schema.toCodecJson(schema)
  return Internal.makeTarget(Arbitrary.schema(schema), property, {
    codec: Internal.jsonCodec(Schema.encodeSync(codec as any), Schema.decodeSync(codec as any)),
    ...options
  })
}

/**
 * Configures a fuzz run.
 *
 * **Details**
 *
 * - `duration`, `executions` and `plateau` are the budget; the first one reached stops the run. Without any of them
 *   the run lasts 10 seconds. `executions` counts exploratory executions, including saved inputs replayed to rebuild
 *   the feature map. `executions: 0` only replays saved failures, which is the regression mode used by test runners.
 *   `plateau` stops after that many executions without new feedback or a new finding.
 * - `seed` fixes every choice the fuzzer makes, so a run bounded by `executions` is identical on every machine.
 *   `duration` only decides how many executions happen.
 * - `size` is the maximum generation size, default 100. `maxShrinks`, default 1000, bounds shrink candidates per
 *   finding. `maxFindings`, default 1, is the number of distinct failure signatures to collect.
 * - `feedback` replaces the injected feedback sources, default `[Fuzz.spans]`. Structural features, cause shapes and
 *   {@link observe} / {@link score} are always collected.
 * - `execution` runs each property evaluation, for example under `FuzzSimulation.execution()`.
 * - `replay` replays one finding; every other option except `execution` is ignored.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Options {
  readonly seed?: string | number | undefined
  readonly duration?: Duration.Input | undefined
  readonly executions?: number | undefined
  readonly plateau?: number | undefined
  readonly size?: number | undefined
  readonly maxShrinks?: number | undefined
  readonly maxFindings?: number | undefined
  readonly feedback?: ReadonlyArray<Feedback> | undefined
  readonly execution?: Execution | undefined
  readonly replay?: Replay | undefined
}

/**
 * Opaque token that replays one finding: the generator tape, the schedule tape, the shrink path and the failure
 * signature.
 *
 * **Gotchas**
 *
 * A token is tied to the generator that produced it. `Arbitrary.checkEffect` does not accept it.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export type Replay = string

/**
 * Identifies a property whose evaluation died.
 *
 * **Details**
 *
 * Unlike `checkEffect`, fuzzing reports a defect raised by the property under test as a finding: a crash is what
 * fuzzing exists to find. Defects raised by generation, feedback, the corpus store or the execution driver are a
 * {@link FuzzError} instead.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Died {
  readonly _tag: "Died"
  readonly defect: unknown
}

/**
 * Identifies a simulated execution that stopped with runnable work exhausted while the property was still running.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Deadlock {
  readonly _tag: "Deadlock"
}

/**
 * Represents why a property was falsified.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export type Failure<E> = Arbitrary.ReturnedFalse | Arbitrary.PropertyError<E> | Died | Deadlock

/**
 * One distinct failure.
 *
 * **Details**
 *
 * `signature` is the deduplication key: `ReturnedFalse`, `PropertyError:<tag>`, `Died:<constructor>` or `Deadlock`,
 * where the tag is the error's `_tag`, else its constructor name, else its `typeof`. Shrinking keeps the signature.
 * `execution` is the exploratory execution that found the failure, or `0` for a saved failure that still fails.
 * `saved` says how a corpus store kept it: `"Value"` survives generator changes, `"Tape"` replays only while the
 * target `revision` is unchanged, `"None"` means no store was provided.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Finding<out A, out E> {
  readonly signature: string
  readonly failure: Failure<E>
  readonly input: A
  readonly initialInput: A
  readonly shrinks: number
  readonly execution: number
  readonly replay: Replay | undefined
  readonly saved: "Value" | "Tape" | "None"
}

/**
 * Counts what a fuzz run did.
 *
 * **Details**
 *
 * `features` counts distinct features per feedback source. Only `structural` and `causes` mean the search explored
 * generator choices and outcome shapes, not code coverage. `regressions` counts saved failures replayed and `stale`
 * counts saved tapes skipped because their revision differs.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Stats {
  readonly seed: string | number
  readonly executions: number
  readonly discards: number
  readonly corpus: number
  readonly features: Readonly<Record<string, number>>
  readonly regressions: number
  readonly stale: number
  readonly stoppedBy: "Duration" | "Executions" | "Plateau" | "Findings" | "Replay"
}

/**
 * Reports a run without findings.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Passed {
  readonly _tag: "Passed"
  readonly stats: Stats
}

/**
 * Reports the distinct failures a run found.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Falsified<out A, out E> {
  readonly _tag: "Falsified"
  readonly findings: Arr.NonEmptyReadonlyArray<Finding<A, E>>
  readonly stats: Stats
}

/**
 * Represents the result of a fuzz run.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export type Report<A, E> = Passed | Falsified<A, E>

/**
 * Reports a failure of the fuzzing infrastructure rather than of the property.
 *
 * **Details**
 *
 * - `Configuration`: invalid options, an invalid replay token, or a corpus store used without a {@link Target}.
 * - `Corpus`: the store failed or holds an unreadable entry.
 * - `Generation`: the Arbitrary died or is not deterministic.
 * - `Feedback`: a feedback source died.
 * - `Execution`: the execution driver died.
 * - `Codec`: a value could not be encoded or decoded, or a saved value uses another codec.
 *
 * @stability unstable
 * @category errors
 * @since 4.0.0
 */
export interface FuzzError extends Cause.YieldableError {
  readonly _tag: "FuzzError"
  readonly reason: "Configuration" | "Corpus" | "Generation" | "Feedback" | "Execution" | "Codec"
  readonly message: string
  readonly cause?: unknown
}

/**
 * Constructs a {@link FuzzError}, for example in a {@link Store} adapter.
 *
 * @stability unstable
 * @category errors
 * @since 4.0.0
 */
export const FuzzError: new(args: {
  readonly reason: FuzzError["reason"]
  readonly message: string
  readonly cause?: unknown
}) => FuzzError = Internal.FuzzError

/**
 * Receives the features one execution produced.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Sink {
  readonly feature: (key: string | number) => void
}

/**
 * A source of feedback that wraps one execution.
 *
 * **When to use**
 *
 * Use to plug platform instrumentation, such as V8 coverage, into the search.
 *
 * **Details**
 *
 * `measure` wraps the execution of one property evaluation and reports features to `sink`. The same feature reported
 * several times counts hits, bucketed as 1, 2, 3, 4-7, 8-15, 16-31, 32-127 and 128 or more. Features are namespaced
 * by `name`, which also labels them in {@link Stats.features}.
 *
 * **Gotchas**
 *
 * `measure` must return the wrapped execution's result unchanged. A defect raised by `measure` is a `FuzzError` with
 * reason `"Feedback"`, never a finding.
 *
 * @stability unstable
 * @category models
 * @since 4.0.0
 */
export interface Feedback {
  readonly name: string
  readonly measure: <A, E, R>(self: Effect.Effect<A, E, R>, sink: Sink) => Effect.Effect<A, E, R>
}

/**
 * Reports `(parent span, span)` edges for every span the execution starts.
 *
 * **Details**
 *
 * Code written with `Effect.fn("name")` or `Effect.withSpan` is already instrumented for this feedback. The installed
 * tracer still receives every span.
 *
 * **Gotchas**
 *
 * Span names built from data, such as ids, make every execution look new. Remove this source from `feedback` for such
 * programs.
 *
 * @stability unstable
 * @category feedback
 * @since 4.0.0
 */
export const spans: Feedback = Internal.spans

/**
 * Records a categorical observation for the current fuzz execution.
 *
 * **When to use**
 *
 * Use to tell the fuzzer that an execution reached a stage worth exploring further, such as a parsed header.
 *
 * **Details**
 *
 * Outside a fuzz execution this does nothing, so it can stay in production code. Repeated calls count hits.
 *
 * @stability unstable
 * @category feedback
 * @since 4.0.0
 */
export const observe: (label: string) => Effect.Effect<void> = Internal.observe

/**
 * Records a score that the fuzzer maximizes for `label`.
 *
 * **When to use**
 *
 * Use to steer the search toward a goal it cannot see, such as queue depth or the length of a matched prefix. Report
 * the negative of a distance to minimize it.
 *
 * **Details**
 *
 * An execution that beats the best score seen for a label joins the corpus. Within one execution the maximum counts.
 * Outside a fuzz execution this does nothing.
 *
 * @stability unstable
 * @category feedback
 * @since 4.0.0
 */
export const score: (label: string, value: number) => Effect.Effect<void> = Internal.score

/**
 * One stored corpus entry. The engine owns the text format; a store keeps the text by kind and key.
 *
 * **Details**
 *
 * `"Failure"` entries are regression fixtures to commit. `"Input"` entries are a search cache.
 *
 * @stability unstable
 * @category corpus
 * @since 4.0.0
 */
export interface StoredEntry {
  readonly kind: "Input" | "Failure"
  readonly key: string
  readonly text: string
}

/**
 * Persists corpus entries per target id.
 *
 * **Details**
 *
 * `save` replaces an entry with the same target, kind and key. A failure is saved before shrinking and saved again,
 * under the same key, with the shrunk value.
 *
 * @stability unstable
 * @category corpus
 * @since 4.0.0
 */
export interface Store {
  readonly load: (target: string) => Effect.Effect<ReadonlyArray<StoredEntry>, FuzzError>
  readonly save: (target: string, entry: StoredEntry) => Effect.Effect<void, FuzzError>
}

/**
 * The corpus store used by {@link runTarget}. The default is no store: the corpus lives in memory for one run.
 *
 * @stability unstable
 * @category corpus
 * @since 4.0.0
 */
export const Corpus: Context.Reference<Store | undefined> = Internal.Corpus

/**
 * Creates a store that keeps entries in memory, shared by every run that uses it.
 *
 * @stability unstable
 * @category corpus
 * @since 4.0.0
 */
export const memoryCorpus: () => Store = Internal.memoryCorpus

/**
 * Supplies schedule choices to an {@link Execution}. Each call returns the next 32-bit word.
 *
 * @stability unstable
 * @category execution
 * @since 4.0.0
 */
export interface ScheduleTape {
  readonly next: () => number
}

/**
 * Reports how an {@link Execution} ended.
 *
 * **Details**
 *
 * `Deadlock` becomes a finding. `Limited` means the driver hit its own resource cap; the execution counts as a
 * discard.
 *
 * @stability unstable
 * @category execution
 * @since 4.0.0
 */
export type ExecutionResult =
  | { readonly _tag: "Completed"; readonly exit: Exit.Exit<unknown, unknown> }
  | { readonly _tag: "Deadlock" }
  | { readonly _tag: "Limited" }

/**
 * Runs one property evaluation, optionally reading schedule choices.
 *
 * **Details**
 *
 * The default runs the evaluation as is. `FuzzSimulation.execution()` runs it under a scheduler and a virtual clock
 * driven by the schedule tape, which makes fiber interleavings part of the fuzzed input.
 *
 * @stability unstable
 * @category execution
 * @since 4.0.0
 */
export interface Execution {
  readonly name: string
  readonly run: <R>(
    self: Effect.Effect<Exit.Exit<unknown, unknown>, never, R>,
    schedule: ScheduleTape
  ) => Effect.Effect<ExecutionResult, never, R>
}

/**
 * Fuzzes a property with an in-memory corpus.
 *
 * **When to use**
 *
 * Use to search an existing `Arbitrary` for a falsifying input far deeper than random checking, with no setup.
 *
 * **Details**
 *
 * The property contract is the one of `Arbitrary.checkEffect`: return `true`, or an Effect of `true`, to pass.
 * Returning anything else, failing, or dying is a finding. Interruption propagates.
 *
 * **Gotchas**
 *
 * The property may run many times on equal inputs and must give the same outcome for the same input. A corpus store
 * needs {@link target} and {@link runTarget}.
 *
 * **Example** (Finding a magic header)
 *
 * ```ts
 * import { Arbitrary, Effect, Fuzz, Schema } from "effect"
 *
 * const byte = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))
 * const parse = (bytes: ReadonlyArray<number>) =>
 *   Effect.gen(function*() {
 *     if (bytes[0] !== 0x7f) return true
 *     yield* Fuzz.observe("magic 1")
 *     if (bytes[1] !== 0x45) return true
 *     yield* Fuzz.observe("magic 2")
 *     return bytes[2] !== 0x4c
 *   })
 *
 * const report = await Effect.runPromise(
 *   Fuzz.run(Arbitrary.schema(Schema.Array(byte)), parse, { seed: 1, executions: 200_000 })
 * )
 * report._tag // => "Falsified"
 * ```
 *
 * @stability unstable
 * @category running
 * @since 4.0.0
 */
export const run = <A, E = never, R = never>(
  arbitrary: Arbitrary.Arbitrary<A>,
  property: (value: A) => boolean | Effect.Effect<boolean, E, R>,
  options?: Options
): Effect.Effect<Report<A, E>, FuzzError, R> =>
  Internal.runTarget(Internal.makeTarget(arbitrary, property, { id: "", revision: "", anonymous: true }), options)

/**
 * Fuzzes a {@link Target}, replaying its saved failures and inputs from the {@link Corpus} store first.
 *
 * **When to use**
 *
 * Use when findings must persist, for example in a test suite where saved failures replay on every run.
 *
 * **Details**
 *
 * Saved failures run first: a saved value through the target codec, otherwise its tape and shrink path when the
 * revision matches. A saved failure that still fails is a finding with `execution: 0`. Then saved inputs of the same
 * revision rebuild the feature map, and the search starts. New interesting inputs and each failure are saved; a
 * failure is saved before shrinking and again with the shrunk value.
 *
 * @stability unstable
 * @category running
 * @since 4.0.0
 */
export const runTarget: <A, E, R>(
  self: Target<A, E, R>,
  options?: Options
) => Effect.Effect<Report<A, E>, FuzzError, R> = Internal.runTarget

/**
 * Formats a report with findings as a diagnostic message, returning `undefined` for a passed report.
 *
 * **Details**
 *
 * The message names each feedback source that produced features. A run whose only features are structural says
 * "structural exploration", because no code coverage or observation guided it.
 *
 * @stability unstable
 * @category converting
 * @since 4.0.0
 */
export const formatReport = <A, E>(report: Report<A, E>): string | undefined => {
  if (report._tag === "Passed") return undefined
  const stats = report.stats
  const sources = Object.keys(stats.features).filter((source) => source !== "structural" && source !== "causes")
  const lines = [
    `Fuzzing found ${report.findings.length} failure(s) in ${stats.executions} execution(s) (seed ${
      Formatter.format(stats.seed)
    })`,
    `Feedback: ${sources.length === 0 ? "structural exploration" : sources.join(", ")}`
  ]
  for (const finding of report.findings) {
    lines.push(
      `- ${finding.signature} after ${finding.shrinks} shrink(s)`,
      `  Input: ${Formatter.format(finding.input, { space: 2 })}`,
      `  Failure: ${describeFailure(finding.failure)}`
    )
    if (finding.replay !== undefined) lines.push(`  Replay: ${finding.replay}`)
    if (finding.saved === "Tape") {
      lines.push(
        "  Saved as a generator tape: it replays only until the target revision changes. Add a codec to keep it."
      )
    }
  }
  return lines.join("\n")
}

const describeFailure = (failure: Failure<unknown>): string => {
  switch (failure._tag) {
    case "PropertyError":
      return Cause.isCause(failure.error) ? Cause.pretty(failure.error) : Formatter.format(failure.error, { space: 2 })
    case "Died":
      return failure.defect instanceof Error ? String(failure.defect.stack) : Formatter.format(failure.defect)
    case "ReturnedFalse":
      return "returned false"
    case "Deadlock":
      return "deadlock: no runnable fiber and no pending timer"
  }
}
