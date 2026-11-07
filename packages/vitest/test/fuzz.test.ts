import { assert, describe, it } from "@effect/vitest"
import * as InternalFuzz from "@effect/vitest/internal/fuzz"
import { Arbitrary, Effect, Fuzz, Schema } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const Small = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 }))

const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), "effect-fuzz-"))

describe("fuzz session switch", () => {
  it("selects tests by EFFECT_FUZZ", () => {
    assert.isUndefined(InternalFuzz.session({}, "parser"))
    assert.isUndefined(InternalFuzz.session({ EFFECT_FUZZ: "" }, "parser"))
    assert.isUndefined(InternalFuzz.session({ EFFECT_FUZZ: "bank" }, "parser"))
    assert.deepStrictEqual(InternalFuzz.session({ EFFECT_FUZZ: "1" }, "parser"), {})
    assert.deepStrictEqual(
      InternalFuzz.session({
        EFFECT_FUZZ: "pars",
        EFFECT_FUZZ_DURATION: "2 minutes",
        EFFECT_FUZZ_EXECUTIONS: "500",
        EFFECT_FUZZ_SEED: "42"
      }, "parser"),
      { duration: "2 minutes", executions: 500, seed: 42 }
    )
    assert.deepStrictEqual(InternalFuzz.session({ EFFECT_FUZZ: "1", EFFECT_FUZZ_SEED: "night" }, "x"), {
      seed: "night"
    })
  })

  it("raises the timeout to the duration plus cleanup, or removes it for execution budgets", () => {
    assert.strictEqual(InternalFuzz.sessionTimeout({}), 40_000)
    assert.strictEqual(InternalFuzz.sessionTimeout({ duration: "1 minute" }), 90_000)
    assert.strictEqual(InternalFuzz.sessionTimeout({ executions: 10 }), 0)
    assert.strictEqual(InternalFuzz.sessionTimeout({ plateau: 10 }), 0)
    assert.strictEqual(InternalFuzz.sessionTimeout({ duration: "1 second", executions: 10 }), 31_000)
  })
})

describe("fuzz file corpus", () => {
  it("puts failures beside the test file and inputs in the cache", () => {
    assert.deepStrictEqual(InternalFuzz.corpusDirectories("/repo/src/Bank.test.ts", "/repo"), {
      failures: "/repo/src/__fuzz__/Bank.test.ts",
      inputs: "/repo/node_modules/.cache/effect-fuzz/src/Bank.test.ts"
    })
  })

  it.effect("saves and loads entries by kind and key", () =>
    Effect.gen(function*() {
      const root = temporary()
      const store = InternalFuzz.fileCorpus({ failures: path.join(root, "f"), inputs: path.join(root, "i") })
      assert.deepStrictEqual(yield* store.load("a b/c"), [])
      yield* store.save("a b/c", { kind: "Input", key: "2", text: "input" })
      yield* store.save("a b/c", { kind: "Failure", key: "1", text: "failure" })
      yield* store.save("a b/c", { kind: "Failure", key: "1", text: "shrunk" })
      fs.writeFileSync(path.join(root, "f", "a-b-c", "0.tmp"), "partial")
      assert.deepStrictEqual(yield* store.load("a b/c"), [
        { kind: "Failure", key: "1", text: "shrunk" },
        { kind: "Input", key: "2", text: "input" }
      ])
      assert.isTrue(fs.existsSync(path.join(root, "f", "a-b-c", "1")))
    }))

  it.effect("reports file system failures as Corpus errors", () =>
    Effect.gen(function*() {
      const root = temporary()
      const file = path.join(root, "file")
      fs.writeFileSync(file, "")
      const store = InternalFuzz.fileCorpus({ failures: file, inputs: file })
      const saveError = yield* Effect.flip(store.save("t", { kind: "Failure", key: "1", text: "x" }))
      assert.deepStrictEqual([saveError.reason, saveError.message.includes("cannot save Failure 1 of t")], [
        "Corpus",
        true
      ])
      fs.mkdirSync(path.join(root, "dir"))
      fs.writeFileSync(path.join(root, "dir", "t"), "")
      const unreadable = InternalFuzz.fileCorpus({ failures: path.join(root, "dir"), inputs: path.join(root, "dir") })
      const loadError = yield* Effect.flip(unreadable.load("t"))
      assert.deepStrictEqual([loadError.reason, loadError.message.includes("cannot read the corpus of t")], [
        "Corpus",
        true
      ])
    }))
})

describe("fuzz targets", () => {
  const run = <A>(target: Fuzz.Target<A, never, never>) =>
    Fuzz.runTarget(target, { seed: 1, executions: 3_000 }).pipe(Effect.provideService(Fuzz.Corpus, Fuzz.memoryCorpus()))

  it.effect("all-Schema inputs save failures as values", () =>
    Effect.gen(function*() {
      const tuple = InternalFuzz.makeTarget([Small, Small], ([a, b]: [number, number]) => a + b < 1500, {
        id: "tuple",
        revision: "1"
      })
      const tupleReport = yield* run(tuple)
      assert.strictEqual(tupleReport._tag === "Falsified" && tupleReport.findings[0].saved, "Value")
      const record = InternalFuzz.makeTarget({ n: Small }, ({ n }: { n: number }) => n < 500, {
        id: "record",
        revision: "1"
      })
      const recordReport = yield* run(record)
      assert.deepStrictEqual(recordReport._tag === "Falsified" && recordReport.findings[0].input, { n: 500 })
    }))

  it.effect("inputs with an Arbitrary save failures as tapes", () =>
    Effect.gen(function*() {
      const small = Arbitrary.schema(Small)
      const tuple = InternalFuzz.makeTarget([small, Small], ([a]: [number, number]) => a < 500, {
        id: "t",
        revision: "1"
      })
      const tupleReport = yield* run(tuple)
      assert.strictEqual(tupleReport._tag === "Falsified" && tupleReport.findings[0].saved, "Tape")
      const record = InternalFuzz.makeTarget({ a: small, b: Small }, ({ a }: { a: number }) => a < 500, {
        id: "r",
        revision: "1"
      })
      const recordReport = yield* run(record)
      assert.deepStrictEqual(recordReport._tag === "Falsified" && recordReport.findings[0].input.a, 500)
    }))
})

describe("fuzz runner", () => {
  it.effect("replays only, searches in a session, and fails on findings", () =>
    Effect.gen(function*() {
      const store = Fuzz.memoryCorpus()
      const logs: Array<string> = []
      const passing = Fuzz.target(Small, () => true, { id: "passing", revision: "1" })
      yield* InternalFuzz.runFuzz(passing, store, { size: 5 }, undefined, (line) => Effect.sync(() => logs.push(line)))
      assert.deepStrictEqual([logs, yield* store.load("passing")], [[], []])
      yield* InternalFuzz.runFuzz(passing, store, { size: 5 }, { seed: 1, executions: 200 }, (line) =>
        Effect.sync(() =>
          logs.push(line)
        ))
      assert.match(logs[0], /^Fuzzed passing: 200 execution\(s\), \d+ corpus input\(s\), features .*Executions$/)
      assert.isTrue((yield* store.load("passing")).length > 0)

      const failing = Fuzz.target(Small, (n) =>
        n < 500, { id: "failing", revision: "1" })
      const found = yield* Effect.flip(
        InternalFuzz.runFuzz(failing, store, undefined, { seed: 1, executions: 2_000 }, () =>
          Effect.void)
      )
      assert.include(found.message, "ReturnedFalse")
      // The saved failure now fails a plain run too.
      const replayed = yield* Effect.flip(InternalFuzz.runFuzz(failing, store, undefined, undefined, () => Effect.void))
      assert.include(replayed.message, "Input: 500")
      const fixed = Fuzz.target(Small, () => true, { id: "failing", revision: "1" })
      yield* InternalFuzz.runFuzz(fixed, store, undefined, undefined, (line) => Effect.sync(() => logs.push(line)))
      assert.strictEqual(logs[1], "Replayed 1 saved failure(s) of failing; skipped 0 stale tape(s)")
    }))
})

describe("fuzz registration", () => {
  it.effect.fuzz("an Effect fuzz test with no saved failures passes", [Small], ([n]) => Effect.succeed(n >= 0))
  it.effect.fuzz("a void Effect fuzz test passes", { n: Small }, ({ n }) => Effect.sync(() => assert.isAtLeast(n, 0)), {
    id: "named",
    revision: "2"
  })
  it.fuzz("a synchronous fuzz test passes", [Small], ([n]) => n >= 0)
  it.fuzz("a void synchronous fuzz test passes", [Arbitrary.schema(Small)], () => {})
})
