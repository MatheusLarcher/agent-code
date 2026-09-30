// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { SpeechSetupProgress } from '../shared/ipc'
import { VOICE_OPTIONS } from '../shared/ipc'
import { KOKORO_VOICES } from './voice/protocol'
import { createSetupReporter } from './voiceProgress'

function collect(task: 'tts' | 'stt'): { sent: SpeechSetupProgress[]; r: ReturnType<typeof createSetupReporter> } {
  const sent: SpeechSetupProgress[] = []
  return { sent, r: createSetupReporter(task, (p) => sent.push(p)) }
}

describe('createSetupReporter', () => {
  it('soma os bytes de todos os arquivos numa barra só e fecha quando o trabalho começa', () => {
    const { sent, r } = collect('stt')
    r.onProgress({ phase: 'download', file: 'encoder.onnx', loaded: 0, total: 300 * 1024 * 1024 })
    r.onProgress({ phase: 'download', file: 'encoder.onnx', loaded: 150 * 1024 * 1024, total: 300 * 1024 * 1024 })
    r.onProgress({ phase: 'download', file: 'decoder.onnx', loaded: 0, total: 100 * 1024 * 1024 })
    r.onProgress({ phase: 'ready' }) // um modelo pronto não fecha: ainda há arquivos
    r.onProgress({ phase: 'download', file: 'decoder.onnx', loaded: 100 * 1024 * 1024, total: 100 * 1024 * 1024 })
    r.onProgress({ phase: 'transcribe' })
    r.finish()
    expect(sent.map((p) => [p.stage, p.percent, p.totalMb])).toEqual([
      ['downloading', 0, 300],
      ['downloading', 50, 300],
      ['downloading', 37, 400],
      ['downloading', 62, 400],
      ['done', undefined, undefined]
    ])
    expect(sent[0].message).toContain('Whisper')
  })

  it('não repete o mesmo percentual', () => {
    const { sent, r } = collect('tts')
    for (let i = 0; i < 5; i++) r.onProgress({ phase: 'download', file: 'model.onnx', loaded: 10, total: 1000 })
    expect(sent).toHaveLength(1)
    expect(sent[0].message).toContain('Kokoro')
  })

  it('modelo já carregado: nenhum aviso', () => {
    const { sent, r } = collect('tts')
    r.onProgress({ phase: 'synthesize' })
    r.finish()
    expect(sent).toEqual([])
  })

  it('carregando do cache mostra "loading"; falha fecha com erro', () => {
    const { sent, r } = collect('tts')
    r.onProgress({ phase: 'load', file: 'model.onnx', loaded: 5, total: 10 })
    r.finish(new Error('falhou'))
    expect(sent.map((p) => p.stage)).toEqual(['loading', 'error'])
  })
})

describe('vozes', () => {
  it('a lista da UI é a mesma do motor Kokoro, com pf_dora primeiro', () => {
    expect(VOICE_OPTIONS.map((v) => v.id)).toEqual([...KOKORO_VOICES])
    expect(VOICE_OPTIONS[0].id).toBe('pf_dora')
  })
})
