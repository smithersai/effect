import { assert, describe, it } from "@effect/vitest"
import { Arbitrary, Clock, Deferred, Duration, Effect, Exit, Fiber, Fuzz, Ref, Schema } from "effect"
import * as Format from "effect/internal/fuzz/format"
import * as Simulation from "effect/internal/fuzz/simulation"
import { FuzzSimulation } from "effect/testing"

const Amount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
const amounts = Arbitrary.schema(Schema.Tuple([Amount, Amount]))

// A check-then-act race: two withdrawals read the balance, check it, then write. The default scheduler runs each
// withdrawal to completion, so money is conserved; a preemption between the read and the write loses an update and
// pays out more than the account held.
const withdraw = Effect.fnUntraced(function*(
  balance: Ref.Ref<number>,
  paid: Ref.Ref<number>,
  amount: number,
  log: Array<string>,
  name: string
) {
  const current = yield* Ref.get(balance)
  log.push(`${name} reads ${current}`)
  if (current < amount) return
  yield* Ref.set(balance, current - amount)
  yield* Ref.update(paid, (total) => total + amount)
  log.push(`${name} writes ${current - amount}`)
})

const conservesMoney = (log: Array<string>) =>
  Effect.fnUntraced(function*([a, b]: readonly [number, number]) {
    log.length = 0
    const balance = yield* Ref.make(100)
    const paid = yield* Ref.make(0)
    yield* Effect.all([withdraw(balance, paid, a, log, "A"), withdraw(balance, paid, b, log, "B")], {
      concurrency: 2
    })
    return (yield* Ref.get(balance)) + (yield* Ref.get(paid)) === 100
  })

describe("FuzzSimulation", () => {
  it.effect("finds a race that checkEffect misses in 10,000 runs, and replays it deterministically", () =>
    Effect.gen(function*() {
      const log: Array<string> = []
      const checked = yield* Arbitrary.checkEffect(amounts, conservesMoney(log), { runs: 10_000, seed: 1 })
      assert.strictEqual(checked._tag, "Passed")

      const execution = FuzzSimulation.execution()
      const report = yield* Fuzz.run(amounts, conservesMoney(log), { execution, seed: 1, executions: 10_000 })
      assert.strictEqual(report._tag, "Falsified")
      if (report._tag !== "Falsified") return
      const finding = report.findings[0]
      assert.strictEqual(finding.signature, "ReturnedFalse")
      // Once both withdrawals read 100, any amounts break conservation, so shrinking reaches the smallest pair.
      assert.deepStrictEqual(finding.input, [1, 1])

      // The same token gives the same interleaving every time.
      const interleavings = new Set<string>()
      for (let index = 0; index < 1_000; index++) {
        const replayed = yield* Fuzz.run(amounts, conservesMoney(log), { execution, replay: finding.replay })
        assert.strictEqual(replayed._tag, "Falsified")
        interleavings.add(log.join(", "))
      }
      assert.strictEqual(interleavings.size, 1)
      assert.deepStrictEqual([...interleavings][0].split(", ").slice(0, 2), ["A reads 100", "B reads 100"])

      // The schedule shrinks toward cooperative scheduling: most words are zero.
      const schedule = Format.decodeReplay(finding.replay!).input.schedule
      assert.isTrue(schedule.filter((word) => word !== 0).length <= 2)

      // Making the read and the write one atomic step fixes it.
      const atomic = Effect.fnUntraced(function*([x, y]: readonly [number, number]) {
        const balance = yield* Ref.make(100)
        const paid = yield* Ref.make(0)
        const take = (amount: number) =>
          Effect.flatMap(
            Ref.modify(balance, (current) => current >= amount ? [amount, current - amount] : [0, current]),
            (taken) => Ref.update(paid, (total) => total + taken)
          )
        yield* Effect.all([take(x), take(y)], { concurrency: 2 })
        return (yield* Ref.get(balance)) + (yield* Ref.get(paid)) === 100
      })
      const fixed = yield* Fuzz.run(amounts, atomic, { execution, seed: 1, executions: 3_000 })
      assert.strictEqual(fixed._tag, "Passed")
    }))

  it.effect("a program waiting forever is a deadlock", () =>
    Effect.gen(function*() {
      const execution = FuzzSimulation.execution()
      const crossed = yield* Fuzz.run(Arbitrary.Constant(0), () =>
        Effect.gen(function*() {
          const left = yield* Deferred.make<void>()
          const right = yield* Deferred.make<void>()
          const a = yield* Effect.forkChild(Effect.andThen(Deferred.await(right), Deferred.succeed(left, undefined)))
          yield* Deferred.await(left)
          yield* Fiber.join(a)
          return true
        }), { execution, seed: 1, executions: 10 })
      assert.strictEqual(crossed._tag === "Falsified" && crossed.findings[0].signature, "Deadlock")
      const forever = yield* Fuzz.run(Arbitrary.Constant(0), () => Effect.as(Effect.sleep(Duration.infinity), true), {
        execution,
        seed: 1,
        executions: 10
      })
      assert.strictEqual(forever._tag === "Falsified" && forever.findings[0].signature, "Deadlock")
    }))

  it.effect("time is virtual: sleeps finish at once, in deadline then registration order", () =>
    Effect.gen(function*() {
      const execution = FuzzSimulation.execution()
      const program = Effect.gen(function*() {
        const order: Array<string> = []
        const start = yield* Clock.currentTimeMillis
        const sleeper = (name: string, duration: Duration.Input) =>
          Effect.andThen(Effect.sleep(duration), Effect.sync(() => order.push(name)))
        yield* Effect.all([sleeper("b", "2 hours"), sleeper("a", "1 hour"), sleeper("c", "2 hours")], {
          concurrency: "unbounded"
        })
        const end = yield* Clock.currentTimeMillis
        const clock = yield* Clock.Clock
        return [
          start,
          end,
          order.join(""),
          yield* Clock.currentTimeNanos,
          yield* Clock.monotonicTimeNanos,
          clock.currentTimeMillisUnsafe(),
          clock.currentTimeNanosUnsafe(),
          clock.monotonicTimeNanosUnsafe()
        ]
      })
      // Schedule word 0 everywhere is ordinary cooperative scheduling.
      const result = yield* execution.run(Effect.exit(program), { next: () => 0 })
      const nanos = BigInt(7_200_000) * BigInt(1_000_000)
      assert.deepStrictEqual(result, {
        _tag: "Completed",
        exit: Exit.succeed([0, 7_200_000, "abc", nanos, nanos, 7_200_000, nanos, nanos])
      })

      // A timeout interrupts the sleep it races, which withdraws that sleep's timer.
      const raced = yield* Fuzz.run(Arbitrary.Constant(0), () =>
        Effect.gen(function*() {
          const exit = yield* Effect.exit(Effect.timeout(Effect.sleep("1 minute"), "1 second"))
          return exit._tag === "Failure" && (yield* Clock.currentTimeMillis) === 1_000
        }), { execution, seed: 1, executions: 50 })
      assert.strictEqual(raced._tag, "Passed")
    }))

  it.effect("an evaluation that exceeds maxSteps is a discard, and its fibers are released", () =>
    Effect.gen(function*() {
      let released = 0
      const execution = FuzzSimulation.execution({ maxSteps: 50, maxOpsBeforeYield: 64 })
      const report = yield* Fuzz.run(Arbitrary.Constant(0), () =>
        Effect.forever(Effect.yieldNow).pipe(
          Effect.ensuring(Effect.sync(() => released++)),
          Effect.as(true)
        ), { execution, seed: 1, executions: 20 })
      assert.deepStrictEqual([report._tag, report.stats.discards, released], ["Passed", 20, 20])
    }))

  it("dispatchers run tasks by priority, then FIFO, and flush drains the queue", () => {
    const world = new Simulation.World({ next: () => 0 }, 100, 2048)
    const dispatcher = world.scheduler.makeDispatcher()
    const order: Array<string> = []
    dispatcher.scheduleTask(() => order.push("late 1"), 1)
    dispatcher.scheduleTask(() => order.push("early 1"), 0)
    dispatcher.scheduleTask(() => order.push("late 2"), 1)
    dispatcher.scheduleTask(() => order.push("early 2"), 0)
    dispatcher.scheduleTask(() => order.push("last"), 2)
    dispatcher.flush()
    assert.deepStrictEqual(order, ["early 1", "early 2", "late 1", "late 2", "last"])
    assert.isUndefined(world.dequeue())
  })
})
