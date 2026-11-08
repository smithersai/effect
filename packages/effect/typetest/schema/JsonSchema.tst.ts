import { Schema } from "effect"
import { describe, expect, it } from "tstyche"

describe("JsonSchema", () => {
  it("preserves the existing Codec views as a subtype", () => {
    expect(Schema.Json).type.toBeAssignableTo<Schema.Codec<Schema.Json>>()
    expect<typeof Schema.Json.Type>().type.toBe<Schema.Json>()
    expect<typeof Schema.Json.Encoded>().type.toBe<Schema.Json>()
    expect<typeof Schema.Json.DecodingServices>().type.toBe<never>()
    expect<typeof Schema.Json.EncodingServices>().type.toBe<never>()
    expect<typeof Schema.Json.Iso>().type.toBe<unknown>()
    expect<typeof Schema.Json["~type.make.in"]>().type.toBe<unknown>()
    expect<typeof Schema.Json["~type.parameters"]>().type.toBe<any>()
  })
  it("retains required readonly keys through all rebuild operations", () => {
    const alias = Schema.Json
    for (
      const schema of [
        alias,
        alias.annotate({ description: "JSON" }),
        alias.annotateKey({ description: "JSON" }),
        alias.check(Schema.makeFilter(() => true)),
        alias.rebuild(alias.ast)
      ]
    ) {
      expect<typeof schema["~type.mutability"]>().type.toBe<"readonly">()
      expect<typeof schema["~type.optionality"]>().type.toBe<"required">()
      expect<typeof schema["~encoded.mutability"]>().type.toBe<"readonly">()
      expect<typeof schema["~encoded.optionality"]>().type.toBe<"required">()
    }
  })
  it("requires keys in nested structs, tuples and records", () => {
    const input = Schema.Struct({ input: Schema.Json })
    const nested = Schema.Struct({ nested: input })
    const tuple = Schema.Tuple([Schema.Json, Schema.String])
    const record = Schema.Record(Schema.Literals(["input"]), Schema.Json)
    expect<typeof input.Type>().type.toBe<{ readonly input: Schema.Json }>()
    expect<typeof nested.Type>().type.toBe<{ readonly nested: { readonly input: Schema.Json } }>()
    expect<typeof tuple.Type>().type.toBe<readonly [Schema.Json, string]>()
    expect<typeof record.Type>().type.toBe<{ readonly input: Schema.Json }>()
    expect<{}>().type.not.toBeAssignableTo<typeof input.Type>()
    expect<{}>().type.not.toBeAssignableTo<typeof input.Encoded>()
    expect<readonly []>().type.not.toBeAssignableTo<typeof tuple.Type>()
  })
  it("preserves deliberate optional and mutable modifiers and widening", () => {
    const optional = Schema.Struct({ input: Schema.optionalKey(Schema.Json) })
    const mutable = Schema.Struct({ input: Schema.mutableKey(Schema.Json) })
    const widened: Schema.Top = Schema.mutableKey(Schema.Json)
    expect<typeof optional.Type>().type.toBe<{ readonly input?: Schema.Json }>()
    expect<typeof mutable.Type>().type.toBe<{ input: Schema.Json }>()
    expect<typeof widened["~type.mutability"]>().type.toBe<Schema.Mutability>()
    expect<typeof widened["~type.optionality"]>().type.toBe<Schema.Optionality>()
  })
})
