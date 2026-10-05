// @vitest-environment node
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FREEZE_LOG_MAX_BATCH, flushFreezeLog, initFreezeLog, logFreezes, sanitizeFreezeBatch, sanitizeFreezeRecord } from './freezeLog'

const dirs: string[] = []
async function userData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'freeze-log-'))
  dirs.push(dir)
  return dir
}

const lines = async (file: string): Promise<Array<Record<string, unknown>>> =>
  (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

const AT = Date.UTC(2026, 9, 5, 12, 0, 0)

afterEach(async () => {
  await flushFreezeLog()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('freezeLog', () => {
  it('grava uma linha JSON por registro em <userData>/logs/travadas.log', async () => {
    const dir = await userData()
    initFreezeLog(dir)
    logFreezes([
      { at: AT, kind: 'trecho', label: 'salvamento', ms: 61.4, conversations: 3, mb: 1.23456, ctx: { tab: 'chat', convId: 'c1', busy: 2, office: false, remote: true } },
      { at: AT, kind: 'troca', target: 'aba', ms: 210 }
    ])
    await flushFreezeLog()
    expect(await lines(join(dir, 'logs', 'travadas.log'))).toEqual([
      { at: new Date(AT).toISOString(), kind: 'trecho', label: 'salvamento', ms: 61, conversations: 3, mb: 1.23, ctx: { tab: 'chat', convId: 'c1', busy: 2, office: false, remote: true } },
      { at: new Date(AT).toISOString(), kind: 'troca', target: 'aba', ms: 210 }
    ])
  })

  it('validação na fronteira: só campos conhecidos, tipos certos, strings ≤ 120, ≤ 3 scripts, sem caminho', () => {
    const out = sanitizeFreezeRecord({
      at: AT,
      kind: 'quadro',
      ms: 300,
      blockingMs: 250.06,
      text: 'minha senha é hunter2',
      title: 'Conversa secreta',
      scripts: [
        { ms: 120, invoker: 'i'.repeat(500), invokerType: 'user-callback', sourceFunctionName: 'f'.repeat(500), sourceFile: 'C:\\Users\\Fulano\\app\\index.js?x=1', sourceCharPosition: 9.6, extra: 'x' },
        { ms: 'muito' },
        { ms: 30, sourceFile: '/home/fulano/chunk.js' },
        { ms: 20 },
        { ms: 10 }
      ],
      ctx: { tab: 't'.repeat(300), convId: 'c1', busy: Infinity, office: 'sim', remote: false, title: 'x' }
    })
    expect(out).toEqual({
      at: new Date(AT).toISOString(),
      kind: 'quadro',
      ms: 300,
      blockingMs: 250.1,
      scripts: [
        { ms: 120, invoker: 'i'.repeat(120), invokerType: 'user-callback', sourceFunctionName: 'f'.repeat(80), sourceFile: 'index.js', sourceCharPosition: 10 },
        { ms: 30, sourceFile: 'chunk.js' }
      ],
      ctx: { tab: 't'.repeat(120), convId: 'c1', remote: false }
    })
    expect(JSON.stringify(out)).not.toMatch(/hunter2|secreta|Fulano|fulano/)
  })

  it('descarta registro inválido: kind/rótulo/alvo desconhecido, ms não finito, não-objeto', () => {
    expect(sanitizeFreezeRecord({ kind: 'outro', ms: 10 })).toBeNull()
    expect(sanitizeFreezeRecord({ kind: 'trecho', label: 'qualquer', ms: 10 })).toBeNull()
    expect(sanitizeFreezeRecord({ kind: 'troca', target: 'janela', ms: 10 })).toBeNull()
    expect(sanitizeFreezeRecord({ kind: 'quadro', ms: Number.NaN })).toBeNull()
    expect(sanitizeFreezeRecord({ kind: 'quadro', ms: -1 })).toBeNull()
    expect(sanitizeFreezeRecord('quadro')).toBeNull()
    expect(sanitizeFreezeRecord(null)).toBeNull()
    // `at` inválido vira a hora do main, sem derrubar o registro.
    expect(sanitizeFreezeRecord({ kind: 'quadro', ms: 150, at: 'ontem' })).toMatchObject({ at: expect.any(String), kind: 'quadro' })
  })

  it('lote: não-array vira vazio e no máximo 50 registros', () => {
    expect(sanitizeFreezeBatch({ kind: 'quadro', ms: 1 })).toEqual([])
    expect(sanitizeFreezeBatch(undefined)).toEqual([])
    const big = Array.from({ length: 80 }, () => ({ at: AT, kind: 'quadro', ms: 150 }))
    expect(sanitizeFreezeBatch(big)).toHaveLength(FREEZE_LOG_MAX_BATCH)
  })

  it('giro por tamanho: passou do limite, o atual vira travadas.1.log e um novo começa', async () => {
    const dir = await userData()
    initFreezeLog(dir, { maxBytes: 300 })
    for (let i = 0; i < 10; i++) logFreezes([{ at: AT, kind: 'trecho', label: 'celular', ms: 60 + i }])
    await flushFreezeLog()
    const current = join(dir, 'logs', 'travadas.log')
    const rotated = join(dir, 'logs', 'travadas.1.log')
    expect((await stat(current)).size).toBeLessThanOrEqual(300)
    expect((await stat(rotated)).size).toBeLessThanOrEqual(300)
    expect((await lines(current)).at(-1)).toMatchObject({ ms: 69 })
    expect((await lines(rotated)).length).toBeGreaterThan(0)
  })

  it('falha de escrita é engolida: não lança, a fila segue e só avisa uma vez', async () => {
    const dir = await userData()
    const notADir = join(dir, 'arquivo')
    await writeFile(notADir, 'x')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    initFreezeLog(notADir)
    expect(() => logFreezes([{ at: AT, kind: 'quadro', ms: 200 }])).not.toThrow()
    expect(() => logFreezes([{ at: AT, kind: 'quadro', ms: 201 }])).not.toThrow()
    expect(() => logFreezes('lixo')).not.toThrow()
    await expect(flushFreezeLog()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    initFreezeLog(dir)
    logFreezes([{ at: AT, kind: 'quadro', ms: 202 }])
    await flushFreezeLog()
    expect(await lines(join(dir, 'logs', 'travadas.log'))).toEqual([expect.objectContaining({ kind: 'quadro', ms: 202 })])
  })
})
