import { describe, it, expect } from 'vitest'
import {
  frameRms,
  newVadState,
  vadStep,
  tryArmedTrigger,
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

describe('tryArmedTrigger — remover o silêncio de antes de falar (não gravar até detectar fala)', () => {
  it('quadro em silêncio: fica "armado" (retorna null) — nada é gravado enquanto não fala', () => {
    for (let t = 16; t <= 10_000; t += 16) {
      expect(tryArmedTrigger(SILENCE_RMS, t)).toBeNull()
    }
  })

  it('no instante exato em que a fala começa, dispara já com hadSpeech=true (o quadro que disparou É fala)', () => {
    const t = 5_000 // ex.: usuário ficou 5s calado antes de falar
    const state = tryArmedTrigger(SPEECH_RMS, t)
    expect(state).not.toBeNull()
    expect(state?.hadSpeech).toBe(true)
    expect(state?.segStartAt).toBe(t) // a gravação nasce NA fala, não nos 5s de silêncio anteriores
    expect(state?.lastVoiceAt).toBe(t)
  })

  it('fluxo completo: silêncio longo → dispara na fala → segue até a pausa fechar a frase', () => {
    let state = null as ReturnType<typeof tryArmedTrigger>
    // longo silêncio antes de falar — nunca dispara
    for (let t = 16; t <= 8_000; t += 16) {
      state = tryArmedTrigger(SILENCE_RMS, t)
      expect(state).toBeNull()
    }
    // fala começa
    state = tryArmedTrigger(SPEECH_RMS, 8_016)
    expect(state).not.toBeNull()
    // segue a frase normalmente com vadStep a partir daqui
    const s = state!
    expect(vadStep(s, SPEECH_RMS, 8_200).end).toBe(false)
    expect(vadStep(s, SILENCE_RMS, 8_200 + VAD_SILENCE_HOLD_MS + 50).end).toBe(true)
  })
})
