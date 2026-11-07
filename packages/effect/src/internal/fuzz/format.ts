import * as Base64Url from "../../encoding/Base64Url.ts"
import * as Tape from "./tape.ts"

/**
 * One generation input: the header that `checkEffect` derives from the attempt index, the value tape, and the schedule
 * tape read by an execution driver. Words past the end of a tape come from its key.
 *
 * @internal
 */
export interface Input {
  readonly size: number
  readonly bias: number
  readonly nullPrototype: boolean
  readonly key: number
  readonly words: ReadonlyArray<number>
  readonly scheduleKey: number
  readonly schedule: ReadonlyArray<number>
}

/** @internal */
export interface Entry {
  readonly kind: "input" | "failure"
  readonly revision: string
  readonly input: Input
  readonly signature?: string | undefined
  readonly path: ReadonlyArray<number>
  readonly codec?: string | undefined
  readonly value?: string | undefined
  readonly note?: string | undefined
}

const header = "effect-fuzz 1"

/** @internal */
export function encodeEntry(entry: Entry): string {
  const lines = [
    header,
    `kind ${entry.kind}`,
    `revision ${entry.revision}`,
    `size ${entry.input.size}`,
    `bias ${entry.input.bias}`,
    `null-prototype ${entry.input.nullPrototype}`,
    `key ${entry.input.key}`,
    `tape ${Tape.encodeWords(entry.input.words)}`,
    `schedule-key ${entry.input.scheduleKey}`,
    `schedule ${Tape.encodeWords(entry.input.schedule)}`
  ]
  if (entry.signature !== undefined) lines.push(`signature ${entry.signature}`)
  lines.push(`path ${entry.path.join(".")}`)
  if (entry.codec !== undefined) lines.push(`codec ${entry.codec}`, `value ${entry.value}`)
  if (entry.note !== undefined) lines.push(...entry.note.split("\n").map((line) => `# ${line}`))
  return lines.join("\n") + "\n"
}

function natural(text: string): number {
  const value = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value)) {
    throw new Error(`expected a non-negative integer, got "${text}"`)
  }
  return value
}

function path(text: string): ReadonlyArray<number> {
  return text === "" ? [] : text.split(".").map(natural)
}

/**
 * Parses an entry written by {@link encodeEntry}. Lines starting with `#` are notes for people and are ignored.
 *
 * @internal
 */
export function decodeEntry(text: string): Entry {
  const lines = text.split("\n")
  if (lines[0] !== header) throw new Error(`expected "${header}" on the first line`)
  const fields = new Map<string, string>()
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]
    if (line === "" || line.startsWith("#")) continue
    const space = line.indexOf(" ")
    fields.set(space === -1 ? line : line.slice(0, space), space === -1 ? "" : line.slice(space + 1))
  }
  const field = (name: string): string => {
    const value = fields.get(name)
    if (value === undefined) throw new Error(`missing field "${name}"`)
    return value
  }
  const kind = field("kind")
  if (kind !== "input" && kind !== "failure") throw new Error(`unknown kind "${kind}"`)
  return {
    kind,
    revision: field("revision"),
    input: {
      size: natural(field("size")),
      bias: natural(field("bias")),
      nullPrototype: field("null-prototype") === "true",
      key: natural(field("key")),
      words: Tape.decodeWords(field("tape")),
      scheduleKey: natural(field("schedule-key")),
      schedule: Tape.decodeWords(field("schedule"))
    },
    signature: fields.get("signature"),
    path: path(field("path")),
    codec: fields.get("codec"),
    value: fields.get("value")
  }
}

const replayPrefix = "fuzz1:"

/** @internal */
export interface ReplayData {
  readonly input: Input
  readonly path: ReadonlyArray<number>
  readonly signature: string
}

/** @internal */
export function encodeReplay(data: ReplayData): string {
  const input = data.input
  return replayPrefix + Base64Url.encode(JSON.stringify([
    input.size,
    input.bias,
    input.nullPrototype,
    input.key,
    Tape.encodeWords(input.words),
    input.scheduleKey,
    Tape.encodeWords(input.schedule),
    data.path,
    data.signature
  ]))
}

/** @internal */
export function decodeReplay(token: string): ReplayData {
  if (!token.startsWith(replayPrefix)) throw new Error(`a fuzz replay token starts with "${replayPrefix}"`)
  const decoded = Base64Url.decode(token.slice(replayPrefix.length))
  if (decoded._tag === "Failure") throw new Error("the replay token is not base64url")
  const json = JSON.parse(new TextDecoder().decode(decoded.success))
  const [size, bias, nullPrototype, key, words, scheduleKey, schedule, steps, signature] = json
  return {
    input: {
      size: natural(String(size)),
      bias: natural(String(bias)),
      nullPrototype: nullPrototype === true,
      key: natural(String(key)),
      words: Tape.decodeWords(String(words)),
      scheduleKey: natural(String(scheduleKey)),
      schedule: Tape.decodeWords(String(schedule))
    },
    path: (steps as ReadonlyArray<unknown>).map((step) => natural(String(step))),
    signature: String(signature)
  }
}
