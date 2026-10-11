import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createScrumLogWriter, parseScrumLog, readScrumLog, readScrumLogStrict } from './scrumLog'
import type { ScrumDecisao } from './scrumTypes'

function decisao(over: Partial<ScrumDecisao> = {}): ScrumDecisao {
  return {
    id: 'd-1',
    at: '2026-10-11T12:00:00.000Z',
    tipo: 'cobrou',
    convId: 'conv-1',
    conversationTitle: 'Conversa',
    envioId: 'env-1',
    entregaId: 'ent-1',
    etapaId: 'acoes',
    etapaN: 3,
    projectCwd: 'C:/proj',
    marco: 150,
    veredito: 'justificado',
    tipoDesvio: null,
    motivo: 'subestimada',
    cobranca: 'feche',
    tempoAtivoMs: 1,
    prazoMin: 20,
    declaradoMin: null,
    decorridoMs: null,
    rota: 'claude-sonnet-5-5',
    durationMs: 10,
    ...over
  }
}

/** Espera a fila do gravador esvaziar (as escritas são em fila, sem promessa exposta). */
async function settle(file: string, lines: number): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const text = await readFile(file, 'utf8').catch(() => '')
    if (text.split('\n').filter(Boolean).length >= lines) return text
    await new Promise((r) => setTimeout(r, 10))
  }
  return readFile(file, 'utf8').catch(() => '')
}

describe('scrumLog — o diário permanente', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'scrum-log-'))
    file = join(dir, 'sub', 'scrum-decisions.log')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('grava uma linha JSON por decisão, em ordem, e relê', async () => {
    const write = createScrumLogWriter(async () => file)
    write(decisao({ id: 'a' }))
    write(decisao({ id: 'b', tipo: 'entregue' }))
    write(decisao({ id: 'c', tipo: 'falha', veredito: 'falha' }))
    await settle(file, 3)
    const lidas = await readScrumLog(async () => file)
    expect(lidas.map((d) => [d.id, d.tipo])).toEqual([['a', 'cobrou'], ['b', 'entregue'], ['c', 'falha']])
  })

  it('NUNCA rotaciona: com o arquivo acima de 2 MB, continua crescendo no mesmo arquivo', async () => {
    const write = createScrumLogWriter(async () => file)
    write(decisao({ id: 'primeira' }))
    await settle(file, 1)
    const grande = `${JSON.stringify(decisao({ id: 'enchimento', motivo: 'x'.repeat(3 * 1024 * 1024) }))}\n`
    await writeFile(file, (await readFile(file, 'utf8')) + grande, 'utf8')
    const antes = (await stat(file)).size
    expect(antes).toBeGreaterThan(2 * 1024 * 1024)
    write(decisao({ id: 'depois' }))
    const text = await settle(file, 3)
    expect((await stat(file)).size).toBeGreaterThan(antes)
    expect(await stat(`${file}.1`).catch(() => null)).toBeNull()
    expect(parseScrumLog(text).map((d) => d.id)).toEqual(['primeira', 'enchimento', 'depois'])
  })

  it('nunca lança: destino ilegível, nulo ou que falha', async () => {
    const quebrado = createScrumLogWriter(async () => {
      throw new Error('disco cheio')
    })
    expect(() => quebrado(decisao())).not.toThrow()
    const nulo = createScrumLogWriter(async () => null)
    expect(() => nulo(decisao())).not.toThrow()
    // Uma pasta no lugar do arquivo: o append falha e é engolido.
    const pasta = createScrumLogWriter(async () => dir)
    expect(() => pasta(decisao())).not.toThrow()
    const circular = decisao() as ScrumDecisao & { self?: unknown }
    circular.self = circular
    expect(() => pasta(circular)).not.toThrow()
    await new Promise((r) => setTimeout(r, 30))
    expect(await readScrumLog(async () => join(dir, 'nao-existe.log'))).toEqual([])
    expect(await readScrumLog(async () => null)).toEqual([])
    expect(await readScrumLog(async () => dir)).toEqual([])
  })

  it('a leitura estrita (aba Histórico): ausente = vazio, ilegível lança', async () => {
    expect(await readScrumLogStrict(async () => join(dir, 'nao-existe.log'))).toEqual([])
    expect(await readScrumLogStrict(async () => null)).toEqual([])
    await expect(readScrumLogStrict(async () => dir)).rejects.toMatchObject({ code: 'EISDIR' })
    await writeFile(join(dir, 'ok.log'), `${JSON.stringify(decisao({ id: 'ok' }))}\n`, 'utf8')
    expect((await readScrumLogStrict(async () => join(dir, 'ok.log'))).map((d) => d.id)).toEqual(['ok'])
  })

  it('a leitura tolera linha quebrada e de outro formato', () => {
    const text = [JSON.stringify(decisao({ id: 'ok-1' })), '{"id":"cortad', '', '[1,2]', '{"id":"x"}', JSON.stringify(decisao({ id: 'ok-2' }))].join('\n')
    expect(parseScrumLog(text).map((d) => d.id)).toEqual(['ok-1', 'ok-2'])
  })
})
