// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  kokoroInstalled: vi.fn(() => false),
  whisperInstalled: vi.fn(() => false),
  prepareVoiceModels: vi.fn(async (_what: string, _onProgress?: (p: unknown) => void, _profile?: string) => {}),
  transcribeWhisper: vi.fn(async (..._args: unknown[]) => 'Olá, este é um teste de transcrição de voz.')
}))
const python = vi.hoisted(() => ({
  isLocalSpeechInstalled: vi.fn(() => false),
  prepareLocalSpeech: vi.fn(async (_model: string, _report: unknown) => {}),
  transcribeLocal: vi.fn(async (_wav: Buffer, _model: string, _report: unknown) => 'ola este e um teste de transcricao de voz')
}))
const service = vi.hoisted(() => ({
  ensureVoiceCacheDir: vi.fn(() => 'C:/local/voice-models'),
  errorText: (err: unknown) => String(err instanceof Error ? err.message : err),
  senderReport: vi.fn(),
  speak: vi.fn(async () => ({ base64: 'UklGRg==', mimeType: 'audio/wav' })),
  withReporter: vi.fn(async (_task: string, _send: unknown, run: (r: { onProgress: () => void }) => Promise<unknown>) =>
    run({ onProgress: () => {} })
  )
}))
vi.mock('electron', () => ({}))
vi.mock('./voice', () => engine)
vi.mock('./speech', () => python)
vi.mock('./voiceService', () => service)

const { installVoiceComponent, parseVoiceComponent, testTranscription, voiceComponentStatus, wordRecall, SELF_TEST_PHRASE } =
  await import('./voiceComponents')

beforeEach(() => {
  for (const fn of [...Object.values(engine), ...Object.values(python)]) fn.mockClear()
  service.speak.mockClear()
})

describe('voiceComponents — o que vem pelo IPC', () => {
  it('aceita só componentes conhecidos', () => {
    expect(parseVoiceComponent({ kind: 'tts' })).toEqual({ kind: 'tts' })
    expect(parseVoiceComponent({ kind: 'whisper', model: 'small-fp32' })).toEqual({ kind: 'whisper', model: 'small-fp32' })
    expect(parseVoiceComponent({ kind: 'whisper', model: 'huge' })).toBeNull()
    expect(parseVoiceComponent({ kind: 'local', model: 'nvidia/canary-1b-v2' })).toEqual({ kind: 'local', model: 'nvidia/canary-1b-v2' })
    expect(parseVoiceComponent({ kind: 'local', model: '../../etc' })).toBeNull()
    expect(parseVoiceComponent('tts')).toBeNull()
    expect(parseVoiceComponent(null)).toBeNull()
  })
})

describe('voiceComponents — status e instalação', () => {
  it('status de cada componente vem do seu próprio cache', () => {
    engine.whisperInstalled.mockReturnValueOnce(true)
    expect(voiceComponentStatus({ kind: 'whisper', model: 'small-fp32' })).toEqual({ installed: true, installing: false })
    expect(engine.whisperInstalled).toHaveBeenLastCalledWith('C:/local/voice-models', 'small-fp32')
    expect(voiceComponentStatus({ kind: 'tts' }).installed).toBe(false)
    python.isLocalSpeechInstalled.mockReturnValueOnce(true)
    expect(voiceComponentStatus({ kind: 'local', model: 'nvidia/parakeet-tdt-0.6b-v3' }).installed).toBe(true)
  })

  it('instala o modelo Whisper ESCOLHIDO (não o salvo) e o Parakeet pelo Python', async () => {
    await installVoiceComponent({ kind: 'whisper', model: 'small-fp32' })
    expect(engine.prepareVoiceModels).toHaveBeenCalledWith('stt', expect.any(Function), 'small-fp32')
    await installVoiceComponent({ kind: 'tts' })
    expect(engine.prepareVoiceModels).toHaveBeenLastCalledWith('tts', expect.any(Function))
    await installVoiceComponent({ kind: 'local', model: 'nvidia/canary-1b-v2' })
    expect(python.prepareLocalSpeech).toHaveBeenCalledWith('nvidia/canary-1b-v2', expect.any(Function))
  })

  it('segundo clique durante a instalação junta-se à primeira; o status diz "instalando"', async () => {
    let release!: () => void
    engine.prepareVoiceModels.mockImplementationOnce(() => new Promise<void>((res) => (release = res)))
    const c = { kind: 'whisper', model: 'turbo-q8' } as const
    const a = installVoiceComponent(c)
    const b = installVoiceComponent(c)
    expect(b).toBe(a)
    expect(voiceComponentStatus(c).installing).toBe(true)
    await vi.waitFor(() => expect(engine.prepareVoiceModels).toHaveBeenCalledTimes(1))
    release()
    await a
    expect(voiceComponentStatus(c).installing).toBe(false)
  })

  it('erro: avisa no canal de progresso, rejeita e libera nova tentativa', async () => {
    const sent: Array<{ stage: string; message: string }> = []
    python.prepareLocalSpeech.mockRejectedValueOnce(new Error('sem CUDA'))
    const c = { kind: 'local', model: 'nvidia/parakeet-tdt-0.6b-v3' } as const
    await expect(installVoiceComponent(c, (p) => sent.push(p))).rejects.toThrow('sem CUDA')
    expect(sent.at(-1)).toEqual({ stage: 'error', message: 'Não consegui instalar: sem CUDA' })
    expect(voiceComponentStatus(c).installing).toBe(false)
    await installVoiceComponent(c)
  })

  it('a última falha fica no status (para quem reabrir) e some na próxima tentativa', async () => {
    python.prepareLocalSpeech.mockRejectedValueOnce(new Error('sem CUDA'))
    const c = { kind: 'local', model: 'nvidia/canary-1b-v2' } as const
    await expect(installVoiceComponent(c)).rejects.toThrow('sem CUDA')
    expect(voiceComponentStatus(c)).toEqual({ installed: false, installing: false, error: 'sem CUDA' })
    expect(voiceComponentStatus({ kind: 'local', model: 'nvidia/parakeet-tdt-0.6b-v3' }).error).toBeUndefined()
    let release!: () => void
    python.prepareLocalSpeech.mockImplementationOnce(() => new Promise<void>((res) => (release = res)))
    const again = installVoiceComponent(c)
    expect(voiceComponentStatus(c).error).toBeUndefined()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await again
    expect(voiceComponentStatus(c).error).toBeUndefined()
  })
})

describe('voiceComponents — Testar transcrição', () => {
  it('Kokoro fala a frase e o Whisper escolhido transcreve de volta', async () => {
    const r = await testTranscription({ kind: 'whisper', model: 'small-fp32' })
    expect(service.speak).toHaveBeenCalledWith(SELF_TEST_PHRASE, {}, expect.any(Function))
    expect(engine.transcribeWhisper).toHaveBeenCalledWith('UklGRg==', 'audio/wav', expect.any(Function), 'small-fp32')
    expect(r).toEqual({ ok: true, expected: SELF_TEST_PHRASE, heard: SELF_TEST_PHRASE })
  })

  it('Parakeet recebe o WAV; acentos e pontuação não contam', async () => {
    const r = await testTranscription({ kind: 'local', model: 'nvidia/parakeet-tdt-0.6b-v3' })
    expect(python.transcribeLocal.mock.calls[0][1]).toBe('nvidia/parakeet-tdt-0.6b-v3')
    expect(r.ok).toBe(true)
  })

  it('texto diferente reprova', async () => {
    engine.transcribeWhisper.mockResolvedValueOnce('hola es tu un test')
    expect((await testTranscription({ kind: 'whisper', model: 'turbo-q8' })).ok).toBe(false)
    expect(wordRecall('a b c d', 'a b c')).toBe(0.75)
    expect(wordRecall('', 'x')).toBe(0)
  })
})
