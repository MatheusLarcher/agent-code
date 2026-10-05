// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSessionLog, initSessionLog, logSession, sanitizeSessionLogFields, type SessionLogFields } from './sessionLog'

const dirs: string[] = []
async function userData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'session-log-'))
  dirs.push(dir)
  return dir
}

const lines = async (file: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

afterEach(async () => {
  await flushSessionLog()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('sessionLog', () => {
  it('grava uma linha JSON por evento em <userData>/logs/sessions.log, com data e evento', async () => {
    const dir = await userData()
    initSessionLog(dir)
    logSession('session-start', { convId: 'c1', model: 'claude-opus-5-5', effort: 'high', account: 'default', resume: true })
    logSession('session-replaced', { convId: 'c1', reason: 'auto-pair', background: false })
    await flushSessionLog()
    const written = await lines(join(dir, 'logs', 'sessions.log'))
    expect(written).toEqual([
      { at: expect.any(String), event: 'session-start', convId: 'c1', model: 'claude-opus-5-5', effort: 'high', account: 'default', resume: true },
      { at: expect.any(String), event: 'session-replaced', convId: 'c1', reason: 'auto-pair', background: false }
    ])
    expect(Number.isNaN(Date.parse(String(written[0].at)))).toBe(false)
  })

  it('nunca grava texto de mensagem nem segredo: só os campos conhecidos, com o tipo certo', () => {
    const fields = {
      convId: 'c1',
      text: 'minha senha é hunter2',
      message: 'conteúdo do usuário',
      token: 'sk-ant-xxx',
      retryable: 'sim',
      idleMs: 1234.6,
      turnIds: ['a', 7, 'b'],
      model: 'm'.repeat(500)
    } as unknown as SessionLogFields
    const out = sanitizeSessionLogFields(fields)
    expect(out).toEqual({ convId: 'c1', idleMs: 1235, turnIds: ['a', 'b'], model: 'm'.repeat(120) })
    expect(JSON.stringify(out)).not.toMatch(/hunter2|sk-ant|usuário/)
  })

  it('rotação por tamanho: passou do limite, o atual vira sessions.1.log e um novo começa', async () => {
    const dir = await userData()
    initSessionLog(dir, { maxBytes: 300 })
    for (let i = 0; i < 10; i++) logSession('stall-warn', { convId: `conv-${i}`, idleMs: 60_000 })
    await flushSessionLog()
    const current = join(dir, 'logs', 'sessions.log')
    const rotated = join(dir, 'logs', 'sessions.1.log')
    expect((await stat(current)).size).toBeLessThanOrEqual(300)
    expect((await stat(rotated)).size).toBeLessThanOrEqual(300)
    // O mais recente está no atual; a rotação mantém só uma geração.
    expect((await lines(current)).at(-1)).toMatchObject({ convId: 'conv-9' })
    expect((await lines(rotated)).length).toBeGreaterThan(0)
  })

  it('falha de escrita é engolida: não lança, a fila segue e só avisa uma vez', async () => {
    const dir = await userData()
    // userData aponta para um ARQUIVO: criar <arquivo>/logs falha sempre.
    const notADir = join(dir, 'arquivo')
    await writeFile(notADir, 'x')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initSessionLog(notADir)
    expect(() => logSession('lease-lost', { convId: 'c1' })).not.toThrow()
    expect(() => logSession('lease-lost', { convId: 'c2' })).not.toThrow()
    await expect(flushSessionLog()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    // Volta a gravar quando o destino é válido.
    initSessionLog(dir)
    logSession('session-kept', { convId: 'c3', reason: 'background', background: true })
    await flushSessionLog()
    expect(await lines(join(dir, 'logs', 'sessions.log'))).toEqual([
      expect.objectContaining({ event: 'session-kept', convId: 'c3', background: true })
    ])
  })
})
