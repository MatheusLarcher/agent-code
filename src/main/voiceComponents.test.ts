// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({
  kokoroInstalled: vi.fn((_dir: string) => false),
  parakeetInstalled: vi.fn((_dir: string) => false),
  prepareVoiceModels: vi.fn(async (_what: string, _onProgress?: (p: unknown) => void) => {})
}))
const service = vi.hoisted(() => ({
  ensureVoiceCacheDir: vi.fn(() => 'C:/local/voice-models'),
  errorText: (err: unknown) => String(err instanceof Error ? err.message : err),
  senderReport: vi.fn(),
  speak: vi.fn(async (..._args: unknown[]) => ({ base64: 'UklGRg==', mimeType: 'audio/wav' })),
  transcribe: vi.fn(async (..._args: unknown[]) => 'Olá, este é um teste de transcrição de voz.'),
  withReporter: vi.fn(async (_task: string, _send: unknown, run: (r: { onProgress: () => void }) => Promise<unknown>) =>
    run({ onProgress: () => {} })
  )
}))
vi.mock('electron', () => ({}))
vi.mock('./voice', () => engine)
vi.mock('./voiceService', () => service)

const { installVoiceComponent, parseVoiceComponent, testTranscription, voiceComponentStatus, wordRecall, SELF_TEST_PHRASE } =
  await import('./voiceComponents')

beforeEach(() => {
  for (const fn of Object.values(engine)) fn.mockClear()
  service.speak.mockClear()
  service.transcribe.mockClear()
  service.withReporter.mockClear()
})

describe('voiceComponents — o que vem pelo IPC', () => {
  it('aceita só componentes conhecidos (tts / stt), sem campos extras', () => {
    expect(parseVoiceComponent({ kind: 'tts' })).toEqual({ kind: 'tts' })
    expect(parseVoiceComponent({ kind: 'stt' })).toEqual({ kind: 'stt' })
    expect(parseVoiceComponent({ kind: 'stt', model: '../../etc' })).toEqual({ kind: 'stt' })
    expect(parseVoiceComponent({ kind: 'whisper', model: 'small-fp32' })).toBeNull()
    expect(parseVoiceComponent({ kind: 'local', model: 'nvidia/canary-1b-v2' })).toBeNull()
    expect(parseVoiceComponent({})).toBeNull()
    expect(parseVoiceComponent('tts')).toBeNull()
    expect(parseVoiceComponent(null)).toBeNull()
  })
})

describe('voiceComponents — status e instalação', () => {
  it('status de cada componente vem do seu próprio cache', () => {
    engine.parakeetInstalled.mockReturnValueOnce(true)
    expect(voiceComponentStatus({ kind: 'stt' })).toEqual({ installed: true, installing: false })
    expect(engine.parakeetInstalled).toHaveBeenLastCalledWith('C:/local/voice-models')
    expect(engine.kokoroInstalled).not.toHaveBeenCalled()

    expect(voiceComponentStatus({ kind: 'tts' }).installed).toBe(false)
    expect(engine.kokoroInstalled).toHaveBeenLastCalledWith('C:/local/voice-models')
    engine.kokoroInstalled.mockReturnValueOnce(true)
    expect(voiceComponentStatus({ kind: 'tts' }).installed).toBe(true)
  })

  it('instala cada componente pelo mesmo caminho de preparo (e aviso) do uso no chat', async () => {
    await installVoiceComponent({ kind: 'stt' })
    expect(engine.prepareVoiceModels).toHaveBeenLastCalledWith('stt', expect.any(Function))
    expect(service.withReporter).toHaveBeenLastCalledWith('stt', expect.any(Function), expect.any(Function))
    await installVoiceComponent({ kind: 'tts' })
    expect(engine.prepareVoiceModels).toHaveBeenLastCalledWith('tts', expect.any(Function))
    expect(service.withReporter).toHaveBeenLastCalledWith('tts', expect.any(Function), expect.any(Function))
  })

  it('segundo clique durante a instalação junta-se à primeira; o status diz "instalando"', async () => {
    let release!: () => void
    engine.prepareVoiceModels.mockImplementationOnce(() => new Promise<void>((res) => (release = res)))
    const c = { kind: 'stt' } as const
    const a = installVoiceComponent(c)
    const b = installVoiceComponent(c)
    expect(b).toBe(a)
    expect(voiceComponentStatus(c).installing).toBe(true)
    expect(voiceComponentStatus({ kind: 'tts' }).installing).toBe(false)
    await vi.waitFor(() => expect(engine.prepareVoiceModels).toHaveBeenCalledTimes(1))
    release()
    await a
    expect(voiceComponentStatus(c).installing).toBe(false)
  })

  it('erro: avisa no canal de progresso, rejeita e libera nova tentativa', async () => {
    const sent: Array<{ stage: string; message: string }> = []
    engine.prepareVoiceModels.mockRejectedValueOnce(new Error('sem rede'))
    const c = { kind: 'stt' } as const
    await expect(installVoiceComponent(c, (p) => sent.push(p))).rejects.toThrow('sem rede')
    expect(sent.at(-1)).toEqual({ stage: 'error', message: 'Não consegui instalar: sem rede' })
    expect(voiceComponentStatus(c).installing).toBe(false)
    await installVoiceComponent(c)
  })

  it('a última falha fica no status (para quem reabrir) e some na próxima tentativa', async () => {
    engine.prepareVoiceModels.mockRejectedValueOnce(new Error('sem rede'))
    const c = { kind: 'stt' } as const
    await expect(installVoiceComponent(c)).rejects.toThrow('sem rede')
    expect(voiceComponentStatus(c)).toEqual({ installed: false, installing: false, error: 'sem rede' })
    expect(voiceComponentStatus({ kind: 'tts' }).error).toBeUndefined()
    let release!: () => void
    engine.prepareVoiceModels.mockImplementationOnce(() => new Promise<void>((res) => (release = res)))
    const again = installVoiceComponent(c)
    expect(voiceComponentStatus(c).error).toBeUndefined()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release()
    await again
    expect(voiceComponentStatus(c).error).toBeUndefined()
  })
})

describe('voiceComponents — Testar transcrição', () => {
  it('Kokoro fala a frase e o Parakeet transcreve de volta', async () => {
    const r = await testTranscription()
    expect(service.speak).toHaveBeenCalledWith(SELF_TEST_PHRASE, {}, expect.any(Function))
    expect(service.transcribe).toHaveBeenCalledWith('UklGRg==', 'audio/wav', expect.any(Function))
    expect(r).toEqual({ ok: true, expected: SELF_TEST_PHRASE, heard: SELF_TEST_PHRASE })
  })

  it('acentos e pontuação não contam', async () => {
    service.transcribe.mockResolvedValueOnce('  ola este e um teste de transcricao de voz  ')
    const r = await testTranscription()
    expect(r).toEqual({ ok: true, expected: SELF_TEST_PHRASE, heard: 'ola este e um teste de transcricao de voz' })
  })

  it('texto diferente reprova', async () => {
    service.transcribe.mockResolvedValueOnce('hola es tu un test')
    expect((await testTranscription()).ok).toBe(false)
    expect(wordRecall('a b c d', 'a b c')).toBe(0.75)
    expect(wordRecall('', 'x')).toBe(0)
  })
})
