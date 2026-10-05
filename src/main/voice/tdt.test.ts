// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { argmax, detokenize, parseVocab, tdtGreedyDecode, type JointStep } from './tdt'

const BLANK = 4
/** Scores that pick `token` and `duration` (vocab of 5 incl. blank, 5 durations). */
const pick = (token: number, duration: number): { tokenLogits: number[]; durationLogits: number[] } => ({
  tokenLogits: [0, 1, 2, 3, 4].map((i) => (i === token ? 5 : -1)),
  durationLogits: [0, 1, 2, 3, 4].map((i) => (i === duration ? 5 : -1))
})

/** A scripted joint: answers by call order, records what it was fed. */
function scripted(script: Array<[number, number]>) {
  const calls: Array<{ frame: number; prev: number; state: number }> = []
  const step: JointStep<number> = async (frame, prev, state) => {
    const [token, duration] = script[calls.length] ?? [BLANK, 1]
    calls.push({ frame, prev, state })
    return { ...pick(token, duration), state: state + 1 }
  }
  return { calls, step }
}

describe('tdtGreedyDecode (TDT greedy, como o onnx-asr)', () => {
  it('pula `duration` quadros, só avança 1 em blank com duração 0, e alimenta o último token', async () => {
    // frame 0: token 1, dur 2 → t=2; frame 2: blank, dur 0 → t=3; frame 3: token 2, dur 0 (fica);
    // frame 3: token 3, dur 1 → t=4; frame 4: blank dur 1 → t=5 (fim).
    const { calls, step } = scripted([
      [1, 2],
      [BLANK, 0],
      [2, 0],
      [3, 1],
      [BLANK, 1]
    ])
    const out = await tdtGreedyDecode(5, BLANK, 0, step)
    expect(out.tokens).toEqual([1, 2, 3])
    expect(out.frames).toEqual([0, 3, 3])
    expect(calls.map((c) => c.frame)).toEqual([0, 2, 3, 3, 4])
    expect(calls.map((c) => c.prev)).toEqual([BLANK, 1, 1, 2, 3])
  })

  it('o estado do decoder só avança quando um token é emitido (blank descarta o novo estado)', async () => {
    const { calls, step } = scripted([
      [BLANK, 1],
      [1, 1],
      [BLANK, 1]
    ])
    await tdtGreedyDecode(3, BLANK, 0, step)
    expect(calls.map((c) => c.state)).toEqual([0, 0, 1]) // after the blank, still 0; after token 1, its new state
  })

  it('limita tokens por quadro (duração 0 repetida não trava o laço)', async () => {
    const step: JointStep<number> = async (_f, _p, s) => ({ ...pick(1, 0), state: s })
    const out = await tdtGreedyDecode(2, BLANK, 0, step, 3)
    expect(out.tokens).toEqual([1, 1, 1, 1, 1, 1])
    expect(out.frames).toEqual([0, 0, 0, 1, 1, 1])
  })

  it('sem quadros, nada', async () => {
    expect(await tdtGreedyDecode(0, BLANK, 0, scripted([]).step)).toEqual({ tokens: [], frames: [] })
  })

  it('argmax devolve o primeiro maior', () => {
    expect(argmax([1, 3, 3, 2])).toBe(1)
    expect(argmax(new Float32Array([-2, -1]))).toBe(1)
  })
})

describe('vocab e texto', () => {
  const vocab = parseVocab(['<unk> 0', '▁ol 1', 'á 2', ', 3', '▁é 4', '▁um 5', '▁te 6', 'ste 7', '. 8', '▁ação 9', '<blk> 10'].join('\n'))

  it('lê "<peça> <id>", troca ▁ por espaço e acha o blank', () => {
    expect(vocab.blank).toBe(10)
    expect(vocab.pieces[1]).toBe(' ol')
  })

  it('junta as peças com espaço só antes de palavra (acentos contam como letra)', () => {
    expect(detokenize([1, 2, 3, 4, 5, 6, 7, 8], vocab)).toBe('olá, é um teste.')
    expect(detokenize([9], vocab)).toBe('ação')
  })

  it('tokens especiais não entram no texto', () => {
    expect(detokenize([0, 1, 2, 10], vocab)).toBe('olá')
  })

  it('vocab sem <blk> ou com id faltando é rejeitado', () => {
    expect(() => parseVocab('a 0\nb 1')).toThrow(/<blk>/)
    expect(() => parseVocab('a 0\n<blk> 2')).toThrow(/id 1/)
  })
})
