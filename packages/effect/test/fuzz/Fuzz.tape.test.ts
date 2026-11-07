import { assert, describe, it } from "@effect/vitest"
import { Arbitrary, Effect, Result, Schema } from "effect"
import * as Engine from "effect/internal/fuzz/engine"
import * as Format from "effect/internal/fuzz/format"
import * as Tape from "effect/internal/fuzz/tape"

interface Tree {
  readonly value: number
  readonly children: ReadonlyArray<Tree>
}
const Tree: Schema.Codec<Tree> = Schema.Struct({
  value: Schema.Int,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Tree> => Tree))
})

const small = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 })))

// Every combinator, recursion, unions and null-prototype records must read the tape the same way with and without
// shrink trees, because the search generates without them and shrinking regenerates with them.
const arbitraries: ReadonlyArray<readonly [string, Arbitrary.Arbitrary<unknown>]> = [
  ["schema primitives", Arbitrary.schema(Schema.Tuple([Schema.String, Schema.Number, Schema.BigInt, Schema.Boolean]))],
  ["union", Arbitrary.schema(Schema.Union([Schema.Literal("a"), Schema.Int, Schema.Array(Schema.String)]))],
  ["recursion", Arbitrary.schema(Tree)],
  ["record", Arbitrary.schema(Schema.Record(Schema.String, Schema.Int))],
  ["map", Arbitrary.map(small, (n) => n * 2)],
  ["filter", Arbitrary.filter(small, (n) => n % 2 === 0)],
  ["filterMap", Arbitrary.filterMap(small, (n) => n > 3 ? Result.succeed(String(n)) : Result.fail(n))],
  ["flatMap", Arbitrary.flatMap(small, (n) => Arbitrary.array(small, { maxLength: n }))],
  ["all", Arbitrary.all({ a: small, b: Arbitrary.array(small) })],
  ["array", Arbitrary.array(Arbitrary.schema(Schema.String))],
  ["constant", Arbitrary.Constant(1)]
]

describe("Fuzz tape", () => {
  for (const [name, arbitrary] of arbitraries) {
    it.effect(`${name}: the same tape gives the same value with and without shrink trees`, () =>
      Effect.gen(function*() {
        const rng = Tape.makeRng(name)
        for (let index = 0; index < 200; index++) {
          const words = Array.from({ length: rng.below(40) }, rng.next)
          const input: Format.Input = {
            size: rng.below(30),
            bias: 2 + rng.below(5),
            nullPrototype: rng.below(2) === 0,
            key: rng.next(),
            words,
            scheduleKey: 0,
            schedule: []
          }
          const fast = yield* Engine.generate(arbitrary.gen, input, false)
          const full = yield* Engine.generate(arbitrary.gen, input, true)
          assert.deepStrictEqual(full.words, fast.words)
          assert.strictEqual(full.attempt._tag, fast.attempt._tag)
          if (full.attempt._tag === "Generated" && fast.attempt._tag === "Generated") {
            assert.deepStrictEqual(full.attempt.value, fast.attempt.value)
          }
          // The canonical tape regenerates the same value.
          const again = yield* Engine.generate(arbitrary.gen, { ...input, words: fast.words }, false)
          assert.deepStrictEqual(again, fast)
        }
      }))
  }

  it("clones read the same words in any order, and copyFrom moves the cursor", () => {
    const used: Tape.Used = { max: 0 }
    const random = Tape.makeTapeRandom([7, 8], 99, used, 0)
    const clone = random.clone()
    const first = [random.nextUint32(), random.nextUint32(), random.nextUint32()]
    const second = [clone.nextUint32(), clone.nextUint32(), clone.nextUint32()]
    assert.deepStrictEqual(first, second)
    assert.deepStrictEqual(first.slice(0, 2), [7, 8])
    assert.strictEqual(first[2], Tape.filler(99, 2))
    assert.strictEqual(used.max, 3)
    const later = random.clone()
    clone.copyFrom(Tape.makeTapeRandom([], 0, { max: 0 }, 1))
    assert.strictEqual(clone.nextUint32(), 8)
    assert.deepStrictEqual(later.snapshot(), [3, 0, 0, 0])
    const double = random.nextDoubleUnsafe()
    assert.isTrue(double >= 0 && double < 1)
  })

  it("words round-trip through base64url", () => {
    const words = [0, 1, 0xffffffff, 0x80000000, 12345]
    assert.deepStrictEqual(Tape.decodeWords(Tape.encodeWords(words)), words)
    assert.deepStrictEqual(Tape.decodeWords(""), [])
    assert.throws(() => Tape.decodeWords("AAA"), /invalid tape/)
    assert.throws(() => Tape.decodeWords("*"), /invalid tape/)
  })

  it("entries round-trip and ignore notes", () => {
    const entry: Format.Entry = {
      kind: "failure",
      revision: "2",
      input: { size: 3, bias: 4, nullPrototype: true, key: 5, words: [1, 2], scheduleKey: 6, schedule: [0, 3] },
      signature: "PropertyError:Boom",
      path: [0, 2],
      codec: "json",
      value: "[1]",
      note: "first\nsecond"
    }
    const text = Format.encodeEntry(entry)
    assert.include(text, "# second")
    const { note: _, ...decoded } = entry
    assert.deepStrictEqual(Format.decodeEntry(text), decoded)
    const input = Format.encodeEntry({ kind: "input", revision: "1", input: entry.input, path: [] })
    assert.deepStrictEqual(Format.decodeEntry(input), {
      kind: "input",
      revision: "1",
      input: entry.input,
      path: [],
      signature: undefined,
      codec: undefined,
      value: undefined
    })
  })

  it("rejects malformed entries", () => {
    const valid = Format.encodeEntry({
      kind: "input",
      revision: "1",
      input: { size: 0, bias: 2, nullPrototype: false, key: 0, words: [], scheduleKey: 0, schedule: [] },
      path: []
    })
    assert.throws(() => Format.decodeEntry("effect-fuzz 2\n"), /first line/)
    assert.throws(() => Format.decodeEntry(valid.replace("revision 1\n", "")), /missing field "revision"/)
    assert.throws(() => Format.decodeEntry(valid.replace("kind input", "kind other")), /unknown kind/)
    assert.throws(() => Format.decodeEntry(valid.replace("size 0", "size -1")), /non-negative integer/)
    assert.throws(() => Format.decodeEntry(valid.replace("size 0", "size 1e300")), /non-negative integer/)
    assert.strictEqual(Format.decodeEntry(valid.replace("revision 1", "revision")).revision, "")
    assert.strictEqual(Format.decodeEntry(valid.replace("revision 1", "revision ")).revision, "")
    assert.throws(() => Format.decodeEntry(valid.replace("path ", "path x")), /non-negative integer/)
    assert.deepStrictEqual(Format.decodeEntry(valid.replace("path ", "path")).path, [])
  })

  it("replay tokens round-trip and reject garbage", () => {
    const data: Format.ReplayData = {
      input: { size: 1, bias: 2, nullPrototype: false, key: 3, words: [4], scheduleKey: 5, schedule: [6] },
      path: [1, 0],
      signature: "ReturnedFalse"
    }
    assert.deepStrictEqual(Format.decodeReplay(Format.encodeReplay(data)), data)
    assert.throws(() => Format.decodeReplay("[1]"), /starts with "fuzz1:"/)
    assert.throws(() => Format.decodeReplay("fuzz1:*"), /not base64url/)
    assert.throws(() => Format.decodeReplay("fuzz1:e30"))
  })

  it("hashes are stable", () => {
    assert.strictEqual(Tape.hashHex("failure\u0000ReturnedFalse"), Tape.hashHex("failure\u0000ReturnedFalse"))
    assert.notStrictEqual(Tape.hashHex("a"), Tape.hashHex("b"))
    assert.strictEqual(Tape.hashHex("a").length, 16)
  })
})
