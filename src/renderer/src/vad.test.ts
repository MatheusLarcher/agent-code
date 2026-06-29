import { describe, it, expect } from 'vitest'
import {
  frameRms,
  newVadState,
  vadStep,
  VAD_SPEECH_RMS,
  VAD_SILENCE_HOLD_MS,
  VAD_MAX_SEG_MS
} from './vad'

const SPEECH_RMS = VAD_SPEECH_RMS + 0.05 // comfortably above the voice threshold
const SILENCE_RMS = 0 // pure silence

describe('frameRms', () => {
  it('é 0 para um quadro silencioso (tudo no centro 128)', () => {
    expect(frameRms(new Uint8Array([128, 128, 128, 128]))).toBe(0)
  })
  it('é > 0 quando o sinal desvia do centro', () => {
    expect(frameRms(new Uint8Array([200, 56, 200, 56]))).toBeGreaterThan(0)
  })
  it('quadro vazio não quebra (retorna 0)', () => {
    expect(frameRms(new Uint8Array(0))).toBe(0)
  })
})

describe('vadStep — descartar silêncio', () => {
  it('silêncio puro NUNCA fecha o segmento e nunca marca fala (→ descartado, não vai pra API)', () => {
    const s = newVadState(0)
    for (let t = 16; t <= 60_000; t += 16) {
      const { end } = vadStep(s, SILENCE_RMS, t)
      expect(end).toBe(false)
    }
    expect(s.hadSpeech).toBe(false)
  })
})

describe('vadStep — segmentar na pausa (não no meio da palavra)', () => {
  it('fala seguida de uma pausa > limiar fecha o segmento; pausa curta não', () => {
    const s = newVadState(0)
    // fala
    expect(vadStep(s, SPEECH_RMS, 100).end).toBe(false)
    expect(s.hadSpeech).toBe(true)
    // pausa curta (abaixo do hold) — não corta no meio da fala
    expect(vadStep(s, SILENCE_RMS, 100 + VAD_SILENCE_HOLD_MS - 50).end).toBe(false)
    // mais fala reinicia a contagem de silêncio (continua a mesma frase)
    expect(vadStep(s, SPEECH_RMS, 100 + VAD_SILENCE_HOLD_MS + 200).end).toBe(false)
    // agora um silêncio acima do hold → fecha a frase
    const tEnd = 100 + VAD_SILENCE_HOLD_MS + 200 + VAD_SILENCE_HOLD_MS + 50
    expect(vadStep(s, SILENCE_RMS, tEnd).end).toBe(true)
  })

  it('monólogo sem pausa fecha pelo teto de segurança (MAX_SEG)', () => {
    const s = newVadState(0)
    // fala contínua: nunca há silêncio longo o bastante, mas o teto força o corte
    let end = false
    for (let t = 16; t <= VAD_MAX_SEG_MS + 1000 && !end; t += 16) {
      end = vadStep(s, SPEECH_RMS, t).end
    }
    expect(end).toBe(true)
    expect(s.hadSpeech).toBe(true)
  })
})
