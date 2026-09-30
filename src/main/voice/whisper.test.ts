// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deviceLabel, gpuDeviceFor } from './protocol'

// transformers is replaced by a fake whose GPU behaviour each test scripts;
// what's under test is the GPU → CPU fallback in whisper.ts.
type Behaviour = 'ok' | 'create-fails' | 'run-fails' | 'slow'
const fake = vi.hoisted(() => ({
  gpu: 'ok' as Behaviour,
  env: { cacheDir: '' },
  created: [] as string[],
  disposed: [] as string[],
  warmupMs: 0
}))

vi.mock('@huggingface/transformers', () => ({
  env: fake.env,
  pipeline: vi.fn(async (_task: string, _model: string, opts: { device: unknown; dtype: unknown }) => {
    const onGpu = typeof opts.device === 'object'
    const tag = onGpu ? `gpu:${JSON.stringify(opts.dtype)}` : 'cpu'
    if (onGpu && fake.gpu === 'create-fails') throw new Error('DirectML indisponível')
    fake.created.push(tag)
    let calls = 0
    const asr = async (audio: Float32Array): Promise<{ text: string }> => {
      calls++
      if (onGpu && fake.gpu === 'slow' && calls === 1) {
        const t = performance.now()
        while (performance.now() - t < fake.warmupMs) {
          /* busy wait: the warm-up is timed with performance.now() */
        }
      }
      // calls 1 = warm-up (silence); the real run fails.
      if (onGpu && fake.gpu === 'run-fails' && calls > 1) throw new Error('token_ids must be a non-empty array of integers.')
      return { text: audio.length === 16000 ? '' : ` texto na ${onGpu ? 'gpu' : 'cpu'} ` }
    }
    return Object.assign(asr, { dispose: async () => void fake.disposed.push(tag) })
  })
}))
vi.mock('./models', () => ({ relay: () => () => undefined, sessionOptions: () => ({}) }))

let dir = ''
beforeEach(() => {
  vi.resetModules()
  dir = mkdtempSync(join(tmpdir(), 'whisper-test-'))
  fake.env.cacheDir = dir
  fake.created = []
  fake.disposed = []
  fake.gpu = 'ok'
  delete process.env.AGENT_CODE_VOICE_DEVICE
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const pcm = new Float32Array(16000 * 5)
const noop = (): void => undefined
const hasGpuPlatform = process.platform === 'win32' || (process.platform === 'linux' && process.arch === 'x64')

describe('gpuDeviceFor / deviceLabel', () => {
  it('DirectML on Windows, CUDA on Linux x64, nothing on macOS or when forced to CPU', () => {
    expect(gpuDeviceFor('win32', 'x64', undefined)).toBe('dml')
    expect(gpuDeviceFor('linux', 'x64', undefined)).toBe('cuda')
    expect(gpuDeviceFor('linux', 'arm64', undefined)).toBeNull()
    expect(gpuDeviceFor('darwin', 'arm64', undefined)).toBeNull()
    expect(gpuDeviceFor('win32', 'x64', 'cpu')).toBeNull()
    expect(deviceLabel('dml')).toBe('GPU (DirectML)')
    expect(deviceLabel('cpu')).toBe('CPU')
  })
})

describe.runIf(hasGpuPlatform)('Whisper GPU → CPU fallback', () => {
  it('turbo runs the fp16 encoder on the GPU and the q8 decoder on the CPU', async () => {
    const { transcribe } = await import('./whisper')
    const r = await transcribe(pcm, 'turbo-q8', noop)
    expect(r).toMatchObject({ text: 'texto na gpu', profile: 'turbo-q8', device: gpuDeviceFor() })
    expect(fake.created).toEqual(['gpu:{"encoder_model":"fp16","decoder_model_merged":"q8"}'])
  })

  it('session creation fails → CPU (q8), with the reason', async () => {
    fake.gpu = 'create-fails'
    const { transcribe } = await import('./whisper')
    const r = await transcribe(pcm, 'turbo-q8', noop)
    expect(r).toMatchObject({ text: 'texto na cpu', device: 'cpu', gpuError: 'DirectML indisponível' })
    expect(fake.created).toEqual(['cpu'])
  })

  it('a run fails on the GPU → disposed, reloaded on the CPU, same audio retried; GPU not tried again', async () => {
    fake.gpu = 'run-fails'
    const { transcribe } = await import('./whisper')
    const r = await transcribe(pcm, 'turbo-q8', noop)
    expect(r).toMatchObject({ text: 'texto na cpu', device: 'cpu' })
    expect(r.gpuError).toMatch(/falhou ao transcrever/)
    expect(fake.disposed).toHaveLength(1)
    const again = await transcribe(pcm, 'turbo-q8', noop)
    expect(again.device).toBe('cpu')
    expect(fake.created.filter((c) => c.startsWith('gpu'))).toHaveLength(1)
  })

  it('a GPU slower than the budget (weak iGPU) → CPU, remembered on disk for later launches', async () => {
    fake.gpu = 'slow'
    fake.warmupMs = 120
    process.env.AGENT_CODE_VOICE_GPU_BUDGET_SEC = '0.05'
    const { transcribe } = await import('./whisper')
    const r = await transcribe(pcm, 'small-fp32', noop)
    expect(r.device).toBe('cpu')
    expect(r.gpuError).toMatch(/aquecimento/)
    const saved = JSON.parse(readFileSync(join(dir, 'whisper-gpu.json'), 'utf8')) as Record<string, string>
    expect(saved['small-fp32']).toMatch(/aquecimento/)

    vi.resetModules() // "next launch": a fresh worker reads the verdict and skips the GPU
    fake.created = []
    const next = await (await import('./whisper')).transcribe(pcm, 'small-fp32', noop)
    expect(next.device).toBe('cpu')
    expect(fake.created).toEqual(['cpu'])
    delete process.env.AGENT_CODE_VOICE_GPU_BUDGET_SEC
  })

  it('AGENT_CODE_VOICE_DEVICE=cpu never touches the GPU; profiles without a GPU encoder stay on the CPU', async () => {
    process.env.AGENT_CODE_VOICE_DEVICE = 'cpu'
    const { transcribe } = await import('./whisper')
    expect((await transcribe(pcm, 'turbo-q8', noop)).device).toBe('cpu')
    delete process.env.AGENT_CODE_VOICE_DEVICE
    expect((await transcribe(pcm, 'small-q8', noop)).device).toBe('cpu')
    expect(fake.created).toEqual(['cpu', 'cpu'])
    expect(existsSync(join(dir, 'whisper-gpu.json'))).toBe(false)
  })

  it('switching profiles disposes the previous model first', async () => {
    const { transcribe } = await import('./whisper')
    await transcribe(pcm, 'turbo-q8', noop)
    await transcribe(pcm, 'small-fp32', noop)
    await transcribe(pcm, 'turbo-q8', noop)
    expect(fake.disposed).toHaveLength(2)
    expect(fake.created).toHaveLength(3)
  })
})
