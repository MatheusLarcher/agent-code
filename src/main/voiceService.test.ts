// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../shared/ipc'
import { DEFAULT_CONFIG } from '../shared/ipc'
import { encodeWavPcm16, parseWav } from './voice/pcm'

const cfg = vi.hoisted(() => ({ current: null as unknown as AppConfig }))
const engine = vi.hoisted(() => ({
  setVoiceCacheDir: vi.fn(),
  synthesizeLocal: vi.fn(),
  transcribeWhisper: vi.fn(async () => 'texto do whisper'),
  stopVoiceEngine: vi.fn(async () => {}),
  setWhisperProfile: vi.fn(),
  getWhisperStatus: vi.fn(() => ({ profile: 'small-fp32', device: 'dml', label: 'GPU (DirectML)' })),
  prepareVoiceModels: vi.fn(async (_what: string, _onProgress?: (p: unknown) => void) => {}),
  voiceModelsInstalled: vi.fn(() => false)
}))
const python = vi.hoisted(() => ({
  transcribeLocal: vi.fn(async (_wav: Buffer, _model: string, _report: unknown) => 'texto do parakeet')
}))
const chromium = vi.hoisted(() => ({
  canDecodeWithChromium: vi.fn(() => true),
  decodeWithChromium: vi.fn(async () => new Float32Array(1600))
}))
vi.mock('electron', () => ({}))
vi.mock('./config', () => ({ loadConfig: () => cfg.current }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ localDir: 'C:/local' }) }))
vi.mock('./speech', () => python)
vi.mock('./voice', () => engine)
vi.mock('./voice/chromiumDecode', () => chromium)

const { installVoice, resolveSpeakOptions, resolveWhisperModel, speak, speechParts, transcribe, voiceInstallStatus, whisperStatus } =
  await import('./voiceService')

function wav(samples: number): string {
  return encodeWavPcm16(new Float32Array(samples).fill(0.1), 24000).toString('base64')
}

beforeEach(() => {
  cfg.current = { ...DEFAULT_CONFIG, voice: { voice: 'pm_alex', speed: 1.25, whisperModel: 'turbo-q8' } }
  for (const fn of Object.values(engine)) fn.mockClear()
  python.transcribeLocal.mockClear()
  chromium.decodeWithChromium.mockClear()
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
  it('prepara Kokoro e depois Whisper (perfil da config) e fecha com um único "done"', async () => {
    const sent: Array<{ stage: string; message: string }> = []
    engine.prepareVoiceModels.mockImplementation(async (what, onProgress) => {
      onProgress?.({ phase: 'download', file: `${what}.onnx`, loaded: 5, total: 10 })
      onProgress?.({ phase: 'ready' })
    })
    await installVoice((p) => sent.push(p))
    expect(engine.prepareVoiceModels.mock.calls.map((c) => c[0])).toEqual(['tts', 'stt'])
    expect(engine.setWhisperProfile).toHaveBeenCalledWith('turbo-q8')
    expect(sent.some((p) => p.stage === 'downloading')).toBe(true)
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

  it('status "instalado" vem dos arquivos no cache do perfil escolhido', () => {
    engine.voiceModelsInstalled.mockReturnValueOnce(true)
    expect(voiceInstallStatus()).toEqual({ installed: true, installing: false })
    expect(engine.voiceModelsInstalled).toHaveBeenLastCalledWith(expect.stringMatching(/voice-models$/), 'turbo-q8')
    expect(voiceInstallStatus().installed).toBe(false)
  })
})

describe('voiceService — ditado', () => {
  it("'whisper' (padrão) vai para o Whisper local com o mime original", async () => {
    cfg.current = { ...cfg.current, transcribeEngine: 'whisper' }
    expect(await transcribe('GkXfow==', 'audio/webm;codecs=opus')).toBe('texto do whisper')
    expect(engine.transcribeWhisper).toHaveBeenCalledWith('GkXfow==', 'audio/webm;codecs=opus', expect.any(Function))
    expect(python.transcribeLocal).not.toHaveBeenCalled()
  })

  it('aplica o modelo Whisper da config a cada ditado (troca sem reiniciar); inválido vira turbo-q8', async () => {
    cfg.current = { ...cfg.current, transcribeEngine: 'whisper' }
    await transcribe('GkXfow==', 'audio/webm')
    expect(engine.setWhisperProfile).toHaveBeenLastCalledWith('turbo-q8')
    cfg.current = { ...cfg.current, voice: { ...cfg.current.voice, whisperModel: 'small-fp32' } }
    await transcribe('GkXfow==', 'audio/webm')
    expect(engine.setWhisperProfile).toHaveBeenLastCalledWith('small-fp32')
    cfg.current = { ...cfg.current, voice: { ...cfg.current.voice, whisperModel: 'huge' as never } }
    await transcribe('GkXfow==', 'audio/webm')
    expect(engine.setWhisperProfile).toHaveBeenLastCalledWith('turbo-q8')
    expect(resolveWhisperModel(undefined)).toBe('turbo-q8')
  })

  it('status: modelo da config e o dispositivo em que rodou', () => {
    cfg.current = { ...cfg.current, voice: { ...cfg.current.voice, whisperModel: 'small-fp32' } }
    expect(whisperStatus()).toEqual({ model: 'small-fp32', device: 'dml', label: 'GPU (DirectML)' })
    expect(engine.setWhisperProfile).toHaveBeenLastCalledWith('small-fp32')
  })

  it("'local' usa o Python; WebM do celular vira WAV antes", async () => {
    cfg.current = { ...cfg.current, transcribeEngine: 'local' }
    expect(await transcribe(Buffer.from('webm-bytes').toString('base64'), 'audio/webm')).toBe('texto do parakeet')
    expect(chromium.decodeWithChromium).toHaveBeenCalledTimes(1)
    const sentWav = python.transcribeLocal.mock.calls[0][0]
    expect(parseWav(sentWav).sampleRate).toBe(16000)

    // WAV do desktop segue direto, sem decodificar.
    const desktopWav = encodeWavPcm16(new Float32Array(160), 16000)
    await transcribe(desktopWav.toString('base64'), 'audio/wav')
    expect(chromium.decodeWithChromium).toHaveBeenCalledTimes(1)
    expect(engine.transcribeWhisper).not.toHaveBeenCalled()
  })
})
