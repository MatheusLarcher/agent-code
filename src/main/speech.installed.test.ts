// @vitest-environment node
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'speech-installed-'))
const userData = join(root, 'userData')
const hfHome = join(root, 'hf')
process.env.HF_HOME = hfHome

vi.mock('electron', () => ({ app: { getPath: () => userData } }))
vi.mock('./store', () => ({ getCacheInfo: () => ({ dir: join(root, 'cache') }) }))
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 1, stdout: '' })),
  spawn: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>
    const stdout = new EventEmitter()
    child.stdout = stdout
    child.stderr = new EventEmitter()
    child.stdin = { write: () => true }
    child.exitCode = null
    child.kill = () => true
    setTimeout(() => stdout.emit('data', Buffer.from('{"event":"start"}\n{"event":"ready"}\n')), 0)
    return child
  })
}))

const { isLocalSpeechInstalled, prepareLocalSpeech } = await import('./speech')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const MODEL = 'nvidia/parakeet-tdt-0.6b-v3'

/** A built transformers env (python + .ready) and a model dir in the HF cache. */
function partialInstall(): void {
  const env = join(userData, 'speech-env', 'transformers')
  const py = process.platform === 'win32' ? join(env, 'Scripts', 'python.exe') : join(env, 'bin', 'python')
  mkdirSync(join(py, '..'), { recursive: true })
  writeFileSync(py, '')
  writeFileSync(join(env, '.ready'), 'transformers>=5.10')
  mkdirSync(join(hfHome, 'hub', `models--${MODEL.replace(/\//g, '--')}`), { recursive: true })
}

describe('isLocalSpeechInstalled — download interrompido', () => {
  it('pasta do modelo sem carga concluída não conta como instalado; depois do prepare, conta', async () => {
    partialInstall()
    expect(isLocalSpeechInstalled(MODEL)).toBe(false)
    await prepareLocalSpeech(MODEL, () => {})
    expect(isLocalSpeechInstalled(MODEL)).toBe(true)
  })
})
