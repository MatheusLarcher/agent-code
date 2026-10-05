/**
 * Token-and-Duration Transducer (TDT) greedy decoding and detokenization for
 * Parakeet TDT — pure logic, no ONNX here (parakeet.ts feeds it). Ported from
 * onnx-asr (istupakov/onnx-asr, src/onnx_asr/asr.py `_AsrWithTransducerDecoding`
 * and models/nemo.py `NemoConformerTdt`):
 *
 *   t = 0
 *   while t < frames:
 *     run the decoder+joint on frame t with the last emitted token (blank at start)
 *     token = argmax(token logits); duration = argmax(duration logits)
 *     if token != blank: emit it and keep the new decoder state
 *     if duration > 0: t += duration                  (the TDT jump)
 *     elif token == blank or maxTokensPerStep emitted on this frame: t += 1
 *
 * The duration logits' index IS the duration (Parakeet TDT v3 uses durations
 * [0, 1, 2, 3, 4]), as onnx-asr assumes.
 */

export interface JointOutput<S> {
  /** Scores over the vocabulary (blank included). */
  tokenLogits: ArrayLike<number>
  /** Scores over the durations; index = frames to advance. */
  durationLogits: ArrayLike<number>
  /** Decoder state after feeding the previous token (kept only if a token is emitted). */
  state: S
}

/** One decoder+joint run: frame `t`, last emitted token (or blank), current state. */
export type JointStep<S> = (frame: number, prevToken: number, state: S) => Promise<JointOutput<S>>

export function argmax(xs: ArrayLike<number>): number {
  let best = 0
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i
  return best
}

export async function tdtGreedyDecode<S>(
  frames: number,
  blank: number,
  initialState: S,
  step: JointStep<S>,
  maxTokensPerStep = 10
): Promise<{ tokens: number[]; frames: number[] }> {
  const tokens: number[] = []
  const at: number[] = []
  let state = initialState
  let t = 0
  let emitted = 0
  while (t < frames) {
    const out = await step(t, tokens.length ? tokens[tokens.length - 1] : blank, state)
    const token = argmax(out.tokenLogits)
    const duration = argmax(out.durationLogits)
    if (token !== blank) {
      state = out.state
      tokens.push(token)
      at.push(t)
      emitted++
    }
    if (duration > 0) {
      t += duration
      emitted = 0
    } else if (token === blank || emitted >= maxTokensPerStep) {
      t += 1
      emitted = 0
    }
  }
  return { tokens, frames: at }
}

export interface Vocab {
  /** id → piece, with SentencePiece's "▁" already turned into a space. */
  pieces: string[]
  blank: number
}

/** vocab.txt of the onnx-asr export: one "<piece> <id>" per line. */
export function parseVocab(text: string): Vocab {
  const pieces: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line) continue
    const cut = line.lastIndexOf(' ')
    const id = Number(line.slice(cut + 1))
    if (cut <= 0 || !Number.isInteger(id) || id < 0) throw new Error(`vocab.txt: linha inválida "${line.slice(0, 40)}"`)
    pieces[id] = line.slice(0, cut).replaceAll('▁', ' ')
  }
  const blank = pieces.indexOf('<blk>')
  if (blank < 0) throw new Error('vocab.txt sem o token <blk>')
  for (let i = 0; i < pieces.length; i++) if (pieces[i] === undefined) throw new Error(`vocab.txt sem o id ${i}`)
  return { pieces, blank }
}

/** A space before a word character survives (as one space); before punctuation
 *  or at the very start it goes. onnx-asr's DECODE_SPACE_PATTERN
 *  (`\A\s|\s\B|(\s)\b`), with Unicode word characters — JS's \b is ASCII-only
 *  and would glue "é" or "ção" to the previous word. */
const SPACE = /^\s|\s(?![\p{L}\p{M}\p{N}_])|(\s)(?=[\p{L}\p{M}\p{N}_])/gu

export function detokenize(ids: readonly number[], vocab: Vocab): string {
  const text = ids
    .map((id) => vocab.pieces[id] ?? '')
    .filter((p) => !/^<[^>]*>$/.test(p.trim())) // <unk>, <blk>, <|…|> never reach the text
    .join('')
  return text.replace(SPACE, (_m, keep: string | undefined) => (keep ? ' ' : '')).trim()
}
