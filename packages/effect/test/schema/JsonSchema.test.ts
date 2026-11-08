import { assert, describe, it } from "@effect/vitest"
import { Option, Schema } from "effect"

describe("JsonSchema", () => {
  it("requires a JSON key through annotation, checks, rebuilds and nesting", () => {
    for (
      const json of [
        Schema.Json,
        Schema.Json.annotate({ description: "JSON" }),
        Schema.Json.check(Schema.makeFilter(() => true)),
        Schema.Json.rebuild(Schema.Json.ast)
      ]
    ) {
      const input = Schema.Struct({ input: json })
      assert.isTrue(Schema.is(input)({ input: null }))
      assert.isTrue(Schema.is(input)({ input: { values: [1, true, null] } }))
      assert.isFalse(Schema.is(input)({}))
      assert.isFalse(Schema.is(input)({ input: undefined }))
      assert.isFalse(Schema.is(input)({ input: () => undefined }))
      assert.deepStrictEqual(Schema.encodeUnknownOption(input)({}), Option.none())
      assert.isFalse(Schema.is(Schema.Struct({ nested: input }))({ nested: {} }))
      assert.isFalse(Schema.is(Schema.Tuple([json]))([]))
      assert.isFalse(Schema.is(Schema.Record(Schema.Literals(["input"]), json))({}))
    }
  })
  it("honors explicit key modifiers", () => {
    assert.isTrue(Schema.is(Schema.Struct({ input: Schema.optionalKey(Schema.Json) }))({}))
    assert.isTrue(Schema.is(Schema.Struct({ input: Schema.mutableKey(Schema.Json) }))({ input: null }))
  })
})
