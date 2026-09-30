// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { espeakToKokoro, KOKORO_TIES, mapPhoneme, phonemizePtBr, phonemizeWith } from './phonemize'

describe('mapPhoneme', () => {
  it('maps every affricate/diphthong to its Kokoro symbol', () => {
    expect(Object.entries(KOKORO_TIES)).toEqual([
      ['tʃ', 'ʧ'],
      ['dʒ', 'ʤ'],
      ['ts', 'ʦ'],
      ['dz', 'ʣ'],
      ['eɪ', 'A'],
      ['aɪ', 'I'],
      ['aʊ', 'W'],
      ['oʊ', 'O'],
      ['ɔɪ', 'Y']
    ])
    for (const [from, to] of Object.entries(KOKORO_TIES)) expect(mapPhoneme(from)).toBe(to)
  })

  it('ignores the stress mark for the lookup and keeps it in front', () => {
    expect(mapPhoneme('ˈtʃ')).toBe('ˈʧ')
    expect(mapPhoneme('ˌdʒ')).toBe('ˌʤ')
    expect(mapPhoneme('ˈaɪ')).toBe('ˈI')
  })

  it('leaves other phonemes alone', () => {
    expect(mapPhoneme('ˈa')).toBe('ˈa')
    expect(mapPhoneme('ɐ̃')).toBe('ɐ̃')
    expect(mapPhoneme('t')).toBe('t')
  })
})

describe('espeakToKokoro', () => {
  it('drops the "_" phoneme separator, keeps word spaces and flattens clauses', () => {
    expect(espeakToKokoro('b_ˈo_ŋ dʒ_ˈi_ɐ | tʃ_ˈaʊ')).toBe('bˈoŋ ʤˈiɐ ʧˈW')
  })

  it('tolerates repeated separators, newlines and empty clauses', () => {
    expect(espeakToKokoro('  o__l_ˈa \n| | m_ˈũ_dʊ ')).toBe('olˈa mˈũdʊ')
  })

  it('does not join t+s from different phonemes into ʦ', () => {
    expect(espeakToKokoro('t_s')).toBe('ts')
    expect(espeakToKokoro('ts')).toBe('ʦ')
  })
})

describe('phonemizeWith', () => {
  const fake = (piece: string): string => piece.split(/\s+/).map((w) => w.split('').join('_')).join(' ')

  it('keeps punctuation between the phonemized pieces', () => {
    expect(phonemizeWith('Olá, tudo bem? Sim!', fake)).toBe('Olá, tudo bem? Sim!')
  })

  it('sends only punctuation-free pieces to eSpeak', () => {
    const seen: string[] = []
    phonemizeWith('Oi — tudo; "certo" (sim)…', (p) => {
      seen.push(p)
      return p
    })
    expect(seen).toEqual(['Oi', 'tudo', 'certo', 'sim'])
  })

  it('skips pieces with no letters or digits', () => {
    const seen: string[] = []
    phonemizeWith('... !!! 42', (p) => {
      seen.push(p)
      return p
    })
    expect(seen).toEqual(['42'])
  })
})

describe('phonemizePtBr (real eSpeak NG, pt-br)', () => {
  it('produces Kokoro-ready pt-BR IPA with punctuation kept', async () => {
    const ps = await phonemizePtBr('Bom dia, tchau!')
    expect(ps).toBe('bˈoŋ ʤˈiæ, tʃˈW!')
    // "dia": eSpeak's single dʒ phoneme → ʤ. "tchau": eSpeak emits t and ʃ as
    // two phonemes, so they stay two symbols — exactly what Kokoro's own
    // Python pipeline (espeak with tie='^') produced for its pt-BR training.
  }, 60_000)

  it('palatalizes t/d before i and maps diphthongs', async () => {
    expect(await phonemizePtBr('noite tarde')).toBe('nˈoɪʧy tˈaɾəʤy')
    expect(await phonemizePtBr('leite, pai e mau.')).toMatch(/^lˈAʧy, pˈI .*mˈW\.$/)
  }, 60_000)

  it('reads numbers through eSpeak', async () => {
    const ps = await phonemizePtBr('42 pessoas.')
    expect(ps).toContain('kwˌaɾˈAŋ')
    expect(ps).not.toMatch(/\d/)
  }, 60_000)
})
