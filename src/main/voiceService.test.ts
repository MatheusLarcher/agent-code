// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../shared/ipc'
import { DEFAULT_CONFIG } from '../shared/ipc'
import { encodeWavPcm16, parseWav } from './voice/pcm'

const cfg = vi.hoisted(() => ({ current: null as unknown as AppConfig }))
const engine = vi.hoisted(() => ({
  setVoiceCacheDir: vi.fn(),
  synthesizeLocal: vi.fn(),
  transcribeSpeech: vi.fn(
    async (_audio: string, _mime: string, onProgress?: (p: unknown) => void): Promise<string> => {
      onProgress?.({ phase: 'transcribe' })
      return 'texto do parakeet'
    }
  ),
  stopVoiceEngine: vi.fn(async () => {}),
  getSttStatus: vi.fn((): { device: string | null; label: string | null; gpuError?: string } => ({ device: 'dml', label: 'GPU (DirectML)' })),
  prepareVoiceModels: vi.fn(async (_what: string, _onProgress?: (p: unknown) => void) => {}),
  voiceModelsInstalled: vi.fn((_dir: string) => false)
}))
vi.mock('electron', () => ({}))
vi.mock('./config', () => ({ loadConfig: () => cfg.current }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ localDir: 'C:/local' }) }))
vi.mock('./voice', () => engine)

const { installVoice, resolveSpeakOptions, speak, speechParts, speechStatus, transcribe, voiceInstallStatus } =
  await import('./voiceService')

function wav(samples: number): string {
  return encodeWavPcm16(new Float32Array(samples).fill(0.1), 24000).toString('base64')
}

beforeEach(() => {
  cfg.current = { ...DEFAULT_CONFIG, voice: { voice: 'pm_alex', speed: 1.25, whisperModel: 'turbo-q8' } }
  for (const fn of Object.values(engine)) fn.mockClear()
  engine.synthesizeLocal.mockImplementation(async () => ({ base64: wav(240), mimeType: 'audio/wav', durationSec: 0.01, chunks: 1 }))
})

describe('voiceService — leitura', () => {
  it('usa a voz e a velocidade da config no Kokoro (speed nativo) e aponta o cache local', async () => {
    const r = await speak('Olá.')
    expect(r.mimeType).toBe('audio/wav')
    expect(engine.synthesizeLocal).toHaveBeenCalledWith('Olá.', { voice: 'pm_alex', speed: 1.25 }, expect.any(Function))
    expect(engine.setVoiceCacheDir).toHaveBeenCalledWith(expect.stringMatching(/C:[\\/]local[\\/]voice-models$/))
  })

  it('"Testar voz": override válido vence; inválido cai na config', () => {
    expect(resolveSpeakOptions({ voice: 'pm_santa', speed: 0.8 })).toEqual({ voice: 'pm_santa', speed: 0.8 })
    expect(resolveSpeakOptions({ voice: 'alloy', speed: 'x' })).toEqual({ voice: 'pm_alex', speed: 1.25 })
    expect(resolveSpeakOptions({ speed: 7 })).toEqual({ voice: 'pm_alex', speed: 2 })
  })

  it('texto do celular é tratado (Markdown → fala) e texto longo sai em fatias num WAV só', async () => {
    await speak('**Negrito** e `código`', { treat: true })
    expect(engine.synthesizeLocal.mock.calls[0][0]).not.toContain('**')

    engine.synthesizeLocal.mockClear()
    const long = Array.from({ length: 800 }, (_, i) => `Frase número ${i} com algum texto.`).join(' ')
    expect(long.length).toBeGreaterThan(20_000)
    const r = await speak(long)
    expect(engine.synthesizeLocal.mock.calls.length).toBeGreaterThan(1)
    for (const call of engine.synthesizeLocal.mock.calls) expect((call[0] as string).length).toBeLessThanOrEqual(15_000)
    const pcm = parseWav(Buffer.from(r.base64, 'base64'))
    expect(pcm.channels[0].length).toBeGreaterThan(240 * engine.synthesizeLocal.mock.calls.length)
  })

  it('speechParts devolve as partes tratadas', () => {
    expect(speechParts('# Título\n\nUma frase. Outra frase.').join(' ')).not.toContain('#')
  })
})

describe('voiceService — instalar voz e transcrição', () => {
  it('prepara Kokoro e depois Parakeet e fecha com um único "done"', async () => {
    const sent: Array<{ stage: string; message: string }> = []
    engine.prepareVoiceModels.mockImplementation(async (what, onProgress) => {
      onProgress?.({ phase: 'download', file: `${what}.onnx`, loaded: 5, total: 10 })
      onProgress?.({ phase: 'ready' })
    })
    await installVoice((p) => sent.push(p))
    expect(engine.prepareVoiceModels.mock.calls.map((c) => c[0])).toEqual(['tts', 'stt'])
    expect(sent.some((p) => p.stage === 'downloading')).toBe(true)
    expect(sent.some((p) => p.stage === 'error')).toBe(false)
    expect(sent.filter((p) => p.stage === 'done')).toEqual([{ stage: 'done', message: 'Voz e transcrição instaladas.' }])
  })

  it('segundo disparo durante a instalação reaproveita a primeira (não baixa duas vezes)', async () => {
    let release!: () => void
    engine.prepareVoiceModels.mockImplementation(() => new Promise<void>((res) => (release = res)))
    const a = installVoice()
    const b = installVoice()
    expect(b).toBe(a)
    expect(voiceInstallStatus().installing).toBe(true)
    await vi.waitFor(() => expect(engine.prepareVoiceModels).toHaveBeenCalledTimes(1))
    release()
    await vi.waitFor(() => expect(engine.prepareVoiceModels).toHaveBeenCalledTimes(2))
    release()
    await a
    expect(voiceInstallStatus().installing).toBe(false)
  })

  it('erro: avisa com mensagem clara, rejeita e libera nova tentativa', async () => {
    const sent: Array<{ stage: string; message: string }> = []
    engine.prepareVoiceModels.mockRejectedValueOnce(new Error('sem rede'))
    await expect(installVoice((p) => sent.push(p))).rejects.toThrow('sem rede')
    expect(sent.at(-1)).toMatchObject({ stage: 'error', message: expect.stringContaining('Não consegui instalar') })
    expect(voiceInstallStatus().installing).toBe(false)
    engine.prepareVoiceModels.mockResolvedValue(undefined)
    await installVoice()
  })

  it('status "instalado" vem dos arquivos no cache local', () => {
    engine.voiceModelsInstalled.mockReturnValueOnce(true)
    expect(voiceInstallStatus()).toEqual({ installed: true, installing: false })
    expect(engine.voiceModelsInstalled).toHaveBeenLastCalledWith(expect.stringMatching(/C:[\\/]local[\\/]voice-models$/))
    expect(voiceInstallStatus().installed).toBe(false)
  })
})

describe('voiceService — ditado', () => {
  it('vai para o Parakeet com o áudio e o mime originais (o motor decodifica WebM/WAV)', async () => {
    expect(await transcribe('GkXfow==', 'audio/webm;codecs=opus')).toBe('texto do parakeet')
    expect(engine.transcribeSpeech).toHaveBeenCalledWith('GkXfow==', 'audio/webm;codecs=opus', expect.any(Function))
  })

  it('valores antigos da config (Whisper/Python) são ignorados: sempre Parakeet', async () => {
    cfg.current = { ...cfg.current, transcribeEngine: 'local', voice: { ...cfg.current.voice, whisperModel: 'small-fp32' } }
    expect(await transcribe('GkXfow==', 'audio/webm')).toBe('texto do parakeet')
    expect(engine.transcribeSpeech).toHaveBeenCalledTimes(1)
    expect(engine.transcribeSpeech).toHaveBeenCalledWith('GkXfow==', 'audio/webm', expect.any(Function))
  })

  it('áudio vazio rejeita sem chamar o motor; mime não-string vira vazio', async () => {
    await expect(transcribe('', 'audio/wav')).rejects.toThrow('áudio vazio')
    await expect(transcribe(42 as never, 'audio/wav')).rejects.toThrow('áudio vazio')
    expect(engine.transcribeSpeech).not.toHaveBeenCalled()
    await transcribe('UklGRg==', undefined as never)
    expect(engine.transcribeSpeech).toHaveBeenLastCalledWith('UklGRg==', '', expect.any(Function))
  })

  it('primeiro uso: o download do Parakeet vira aviso que fecha ao transcrever; modelo já carregado não avisa', async () => {
    const sent: Array<{ stage: string; message: string }> = []
    engine.transcribeSpeech.mockImplementationOnce(async (_a, _m, onProgress) => {
      onProgress?.({ phase: 'download', file: 'encoder.onnx', loaded: 5, total: 10 })
      onProgress?.({ phase: 'transcribe' })
      return 'oi'
    })
    expect(await transcribe('GkXfow==', 'audio/webm', (p) => sent.push(p))).toBe('oi')
    expect(sent.map((p) => p.stage)).toEqual(['downloading', 'done'])
    expect(sent[0].message).toContain('Parakeet')

    const quiet: unknown[] = []
    await transcribe('GkXfow==', 'audio/webm', (p) => quiet.push(p))
    expect(quiet).toEqual([])
  })

  it('erro do motor durante o download rejeita e fecha o aviso com erro', async () => {
    const sent: Array<{ stage: string; message: string }> = []
    engine.transcribeSpeech.mockImplementationOnce(async (_a, _m, onProgress) => {
      onProgress?.({ phase: 'download', file: 'encoder.onnx', loaded: 1, total: 10 })
      throw new Error('sem rede')
    })
    await expect(transcribe('GkXfow==', 'audio/webm', (p) => sent.push(p))).rejects.toThrow('sem rede')
    expect(sent.map((p) => p.stage)).toEqual(['downloading', 'error'])
  })

  it('status: o dispositivo em que o Parakeet rodou (e por que a GPU caiu)', () => {
    expect(speechStatus()).toEqual({ device: 'dml', label: 'GPU (DirectML)' })
    engine.getSttStatus.mockReturnValueOnce({ device: 'cpu', label: 'CPU', gpuError: 'sem DirectML' })
    expect(speechStatus()).toEqual({ device: 'cpu', label: 'CPU', gpuError: 'sem DirectML' })
  })
})
