import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serializeCard, type PlanCard } from './planningModel'
import {
  createPlan,
  deleteCard,
  ensureSandboxGitignore,
  listHandoffs,
  listPlans,
  openPlan,
  PlanNotFoundError,
  RevConflictError,
  RoteiroConflictError,
  saveCard,
  saveLayout,
  saveRoteiro,
  SANDBOX_GITIGNORE_LINE,
  writeHandoff
} from './planningStore'
import { isOwnWrite, resetOwnWrites } from './planningWrites'

let cwd: string

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-'))
})

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
})

const card = (over: Partial<PlanCard> = {}): PlanCard => ({
  id: 'req-1',
  tipo: 'requisito',
  titulo: 'Requisito',
  links: [],
  rev: 0,
  corpo: 'Ver [[dec-1]].\n',
  ...over
})

describe('planningStore', () => {
  it('cria, grava e reabre sem perda (round-trip)', async () => {
    await createPlan(cwd, 'checkout', 'Checkout novo')
    const saved = await saveCard(cwd, 'checkout', card({ links: ['dec-1'] }), 0)
    expect(saved.rev).toBe(1)
    const roteiro = { titulo: 'Checkout novo', etapas: [{ id: 'etapa-1', titulo: 'Req', status: 'pendente' as const }] }
    expect(await saveRoteiro(cwd, 'checkout', roteiro, 1)).toEqual({ ...roteiro, rev: 2 })
    const layout = { positions: { 'req-1': { x: 10, y: -5.5 } }, viewport: { x: 0, y: 0, zoom: 1.25 } }
    await saveLayout(cwd, 'checkout', layout)

    const plan = await openPlan(cwd, 'checkout')
    expect(plan.roteiro).toEqual({ ...roteiro, rev: 2 })
    expect(plan.cards).toEqual([saved])
    expect(plan.layout).toEqual(layout)
    expect(await listPlans(cwd)).toEqual(['checkout'])

    // Gravar de novo o que foi lido produz o mesmo arquivo.
    const file = path.join(cwd, 'docs', 'spec', 'checkout', 'cards', 'req-1.md')
    const before = await fs.readFile(file, 'utf8')
    const again = await saveCard(cwd, 'checkout', plan.cards[0], 1)
    const reread = (await openPlan(cwd, 'checkout')).cards[0]
    expect(reread).toEqual({ ...again, rev: 2 })
    expect((await fs.readFile(file, 'utf8')).replace('rev: 2', 'rev: 1')).toBe(before)
    expect((await fs.readdir(path.dirname(file))).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('recusa sugestão sem fonte', async () => {
    await createPlan(cwd, 'p', 'P')
    await expect(saveCard(cwd, 'p', card({ id: 's1', tipo: 'sugestao' }), 0)).rejects.toThrow(/fonte/)
  })

  it('recusa rev desatualizado devolvendo o card atual', async () => {
    await createPlan(cwd, 'p', 'P')
    await saveCard(cwd, 'p', card(), 0)
    await saveCard(cwd, 'p', card({ titulo: 'v2' }), 1)
    const err = await saveCard(cwd, 'p', card({ titulo: 'velho' }), 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RevConflictError)
    expect((err as RevConflictError).current).toMatchObject({ titulo: 'v2', rev: 2 })
    await expect(deleteCard(cwd, 'p', 'req-1', 1)).rejects.toBeInstanceOf(RevConflictError)
    await deleteCard(cwd, 'p', 'req-1', 2)
    expect((await openPlan(cwd, 'p')).cards).toEqual([])
  })

  it('recusa escape de pasta por slug, id e symlink', async () => {
    await createPlan(cwd, 'p', 'P')
    for (const slug of ['..', '../x', 'a/b', 'a\\b', path.join(cwd, 'x'), 'A']) {
      await expect(openPlan(cwd, slug)).rejects.toThrow(/slug/)
      await expect(createPlan(cwd, slug, 't')).rejects.toThrow(/slug/)
    }
    for (const id of ['../../x', '..', 'a/b', 'C:\\x']) {
      await expect(saveCard(cwd, 'p', card({ id }), 0)).rejects.toThrow(/id/)
      await expect(deleteCard(cwd, 'p', id, 0)).rejects.toThrow(/id/)
    }
    await expect(listPlans('relativo')).rejects.toThrow(/absoluto/)

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-out-'))
    try {
      const cardsDir = path.join(cwd, 'docs', 'spec', 'p', 'cards')
      await fs.rm(cardsDir, { recursive: true })
      await fs.symlink(outside, cardsDir, 'junction')
      await expect(saveCard(cwd, 'p', card(), 0)).rejects.toThrow(/symlink/)
      expect(await fs.readdir(outside)).toEqual([])

      await fs.symlink(outside, path.join(cwd, 'docs', 'spec', 'fora'), 'junction')
      await expect(openPlan(cwd, 'fora')).rejects.toThrow(/escapa/)
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('.gitignore: cria, não duplica e preserva conteúdo e CRLF', async () => {
    const gi = path.join(cwd, '.gitignore')
    await createPlan(cwd, 'a', 'A')
    expect(await fs.readFile(gi, 'utf8')).toBe(`${SANDBOX_GITIGNORE_LINE}\n`)
    await createPlan(cwd, 'b', 'B')
    await ensureSandboxGitignore(cwd)
    expect(await fs.readFile(gi, 'utf8')).toBe(`${SANDBOX_GITIGNORE_LINE}\n`)

    await fs.writeFile(gi, 'node_modules\r\nout')
    await ensureSandboxGitignore(cwd)
    await ensureSandboxGitignore(cwd)
    expect(await fs.readFile(gi, 'utf8')).toBe(`node_modules\r\nout\r\n${SANDBOX_GITIGNORE_LINE}\r\n`)
  })

  it('createPlan recusa slug já existente', async () => {
    await createPlan(cwd, 'p', 'P')
    await expect(createPlan(cwd, 'p', 'P')).rejects.toThrow(/já existe/)
  })

  it('writeHandoff numera sequencialmente por dia', async () => {
    await createPlan(cwd, 'p', 'P')
    const d1 = new Date(2026, 8, 22, 10)
    const a = await writeHandoff(cwd, 'p', 'um', d1)
    const b = await writeHandoff(cwd, 'p', 'dois', d1)
    const c = await writeHandoff(cwd, 'p', 'tres', new Date(2026, 8, 23, 10))
    expect(path.basename(a)).toBe('2026-09-22-01.md')
    expect(path.basename(b)).toBe('2026-09-22-02.md')
    expect(path.basename(c)).toBe('2026-09-23-01.md')
    expect(path.dirname(a)).toBe(path.join(cwd, 'docs', 'spec', 'p', '_handoff'))
    expect(await fs.readFile(b, 'utf8')).toBe('dois')
  })

  it('openPlan tolera card malformado: os válidos seguem, os quebrados vão para invalid', async () => {
    await createPlan(cwd, 'p', 'P')
    const ok = await saveCard(cwd, 'p', card(), 0)
    const dir = path.join(cwd, 'docs', 'spec', 'p', 'cards')
    await fs.writeFile(path.join(dir, 'quebrado.md'), 'sem frontmatter nenhum')
    await fs.writeFile(path.join(dir, 'sug.md'), '---\nid: "sug"\ntipo: "sugestao"\ntitulo: "x"\nrev: 1\n---\n')
    await fs.writeFile(path.join(dir, 'Nome Ruim.md'), serializeCard(card({ id: 'x' })))
    await fs.writeFile(path.join(dir, 'outro.md'), serializeCard(card({ id: 'req-9' })))
    await fs.writeFile(path.join(dir, 'leia.txt'), 'não é card')

    const plan = await openPlan(cwd, 'p')
    expect(plan.cards).toEqual([ok])
    expect(plan.invalid.map((i) => i.file)).toEqual([
      'cards/Nome Ruim.md',
      'cards/outro.md',
      'cards/quebrado.md',
      'cards/sug.md'
    ])
    const byFile = Object.fromEntries(plan.invalid.map((i) => [i.file, i.error]))
    expect(byFile['cards/quebrado.md']).toMatch(/frontmatter/)
    expect(byFile['cards/sug.md']).toMatch(/fonte/)
    expect(byFile['cards/Nome Ruim.md']).toMatch(/id do card/)
    expect(byFile['cards/outro.md']).toMatch(/difere do nome/)
  })

  it('openPlan de slug inexistente lança PlanNotFoundError', async () => {
    await expect(openPlan(cwd, 'nada')).rejects.toBeInstanceOf(PlanNotFoundError)
    await expect(saveRoteiro(cwd, 'nada', { titulo: 'x', etapas: [] }, 0)).rejects.toBeInstanceOf(PlanNotFoundError)
  })

  it('registra como próprias as gravações e remoções que faz (eco para o vigia)', async () => {
    resetOwnWrites()
    await createPlan(cwd, 'p', 'P')
    const dir = path.join(cwd, 'docs', 'spec', 'p')
    const cardPath = path.join(dir, 'cards', 'req-1.md')
    await saveCard(cwd, 'p', card(), 0)
    expect(isOwnWrite(cardPath, await fs.readFile(cardPath))).toBe(true)
    await saveRoteiro(cwd, 'p', { titulo: 'P2', etapas: [] }, 1)
    expect(isOwnWrite(path.join(dir, '_roteiro.md'), await fs.readFile(path.join(dir, '_roteiro.md')))).toBe(true)
    await saveLayout(cwd, 'p', { positions: { 'req-1': { x: 1, y: 2 } } })
    expect(isOwnWrite(path.join(dir, '_canvas.json'), await fs.readFile(path.join(dir, '_canvas.json')))).toBe(true)
    await deleteCard(cwd, 'p', 'req-1', 1)
    expect(isOwnWrite(cardPath, null)).toBe(true)
    // Conteúdo que o app não gravou não é eco.
    expect(isOwnWrite(path.join(dir, '_roteiro.md'), 'editado à mão')).toBe(false)
  })
})

describe('planningStore — rev do roteiro', () => {
  const roteiroFile = (): string => path.join(cwd, 'docs', 'spec', 'p', '_roteiro.md')
  const etapa = (id: string, status: 'pendente' | 'concluida' = 'pendente') => ({ id, titulo: id.toUpperCase(), status })

  it('createPlan nasce com rev 1, em disco e no retorno', async () => {
    const created = await createPlan(cwd, 'p', 'P')
    expect(created.roteiro).toEqual({ titulo: 'P', rev: 1, etapas: [] })
    expect(await fs.readFile(roteiroFile(), 'utf8')).toBe('# P\n<!-- rev: 1 -->\n\n')
    expect((await openPlan(cwd, 'p')).roteiro.rev).toBe(1)
  })

  it('grava só com o rev em disco e incrementa; rev velho lança RoteiroConflictError com o atual', async () => {
    await createPlan(cwd, 'p', 'P')
    const v2 = await saveRoteiro(cwd, 'p', { titulo: 'P', etapas: [etapa('a')] }, 1)
    expect(v2).toEqual({ titulo: 'P', rev: 2, etapas: [etapa('a')] })
    const before = await fs.readFile(roteiroFile(), 'utf8')

    const err = await saveRoteiro(cwd, 'p', { titulo: 'P', etapas: [etapa('velho')] }, 1).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RoteiroConflictError)
    expect((err as RoteiroConflictError).expectedRev).toBe(1)
    expect((err as RoteiroConflictError).current).toEqual(v2)
    expect((err as Error).message).toMatch(/esperado 1, atual 2/)
    expect(await fs.readFile(roteiroFile(), 'utf8')).toBe(before) // nada gravado

    expect((await saveRoteiro(cwd, 'p', { titulo: 'P', etapas: [etapa('a', 'concluida')] }, 2)).rev).toBe(3)
    expect((await openPlan(cwd, 'p')).roteiro).toEqual({ titulo: 'P', rev: 3, etapas: [etapa('a', 'concluida')] })
  })

  it('roteiro gravado antes do rev abre como rev 0 e aceita gravar com expectedRev 0', async () => {
    await createPlan(cwd, 'p', 'P')
    await fs.writeFile(roteiroFile(), '# Antigo\n\n- [concluida] a: A\n')
    expect((await openPlan(cwd, 'p')).roteiro).toEqual({ titulo: 'Antigo', rev: 0, etapas: [etapa('a', 'concluida')] })
    await expect(saveRoteiro(cwd, 'p', { titulo: 'Antigo', etapas: [] }, 1)).rejects.toBeInstanceOf(RoteiroConflictError)
    const saved = await saveRoteiro(cwd, 'p', { titulo: 'Antigo', etapas: [etapa('a', 'concluida'), etapa('b')] }, 0)
    expect(saved.rev).toBe(1)
    expect(await fs.readFile(roteiroFile(), 'utf8')).toBe('# Antigo\n<!-- rev: 1 -->\n\n- [concluida] a: A\n- [pendente] b: B\n')
  })

  it('duas gravações simultâneas com o mesmo rev: uma grava, a outra conflita', async () => {
    await createPlan(cwd, 'p', 'P')
    const results = await Promise.allSettled([
      saveRoteiro(cwd, 'p', { titulo: 'P', etapas: [etapa('tela')] }, 1),
      saveRoteiro(cwd, 'p', { titulo: 'P', etapas: [etapa('manager')] }, 1)
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(lost.reason).toBeInstanceOf(RoteiroConflictError)
    const won = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ rev: number }>
    expect(won.value.rev).toBe(2)
    expect((await openPlan(cwd, 'p')).roteiro.rev).toBe(2)
  })
})

describe('planningStore — cards na fila por arquivo', () => {
  const settled = (results: PromiseSettledResult<unknown>[]): string[] => results.map((r) => r.status).sort()

  it('dois saveCard simultâneos do mesmo card novo (rev 0): um grava, o outro conflita', async () => {
    await createPlan(cwd, 'p', 'P')
    const results = await Promise.allSettled([
      saveCard(cwd, 'p', card({ titulo: 'da tela' }), 0),
      saveCard(cwd, 'p', card({ titulo: 'do manager' }), 0)
    ])
    expect(settled(results)).toEqual(['fulfilled', 'rejected'])
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(lost.reason).toBeInstanceOf(RevConflictError)
    const won = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<PlanCard>
    // O perdedor recebe exatamente o que o vencedor gravou — nunca uma gravação por cima.
    expect((lost.reason as RevConflictError).current).toEqual(won.value)
    expect((await openPlan(cwd, 'p')).cards).toEqual([won.value])
  })

  it('saveCard e deleteCard simultâneos com o mesmo rev: só um vence', async () => {
    await createPlan(cwd, 'p', 'P')
    await saveCard(cwd, 'p', card(), 0)
    const results = await Promise.allSettled([
      saveCard(cwd, 'p', card({ titulo: 'editado' }), 1),
      deleteCard(cwd, 'p', 'req-1', 1)
    ])
    expect(settled(results)).toEqual(['fulfilled', 'rejected'])
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(lost.reason).toBeInstanceOf(RevConflictError)
    const cards = (await openPlan(cwd, 'p')).cards
    if (results[0].status === 'fulfilled') expect(cards).toMatchObject([{ titulo: 'editado', rev: 2 }])
    else expect(cards).toEqual([])
  })

  it('dez edições simultâneas com o mesmo rev: exatamente uma grava', async () => {
    await createPlan(cwd, 'p', 'P')
    await saveCard(cwd, 'p', card(), 0)
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => saveCard(cwd, 'p', card({ titulo: `v${i}` }), 1))
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect((await openPlan(cwd, 'p')).cards[0].rev).toBe(2)
  })

  it('cards diferentes não esperam um pelo outro', async () => {
    await createPlan(cwd, 'p', 'P')
    const [a, b] = await Promise.all([saveCard(cwd, 'p', card({ id: 'a' }), 0), saveCard(cwd, 'p', card({ id: 'b' }), 0)])
    expect([a.rev, b.rev]).toEqual([1, 1])
  })
})

describe('planningStore — handoffs', () => {
  const handoffDir = (): string => path.join(cwd, 'docs', 'spec', 'p', '_handoff')

  it('listHandoffs: vazio sem a pasta; depois, na ordem de gravação com conteúdo e createdAt', async () => {
    await createPlan(cwd, 'p', 'P')
    expect(await listHandoffs(cwd, 'p')).toEqual([])
    const before = Date.now()
    await writeHandoff(cwd, 'p', 'segundo dia', new Date(2026, 8, 23, 10))
    await writeHandoff(cwd, 'p', 'um', new Date(2026, 8, 22, 10))
    await writeHandoff(cwd, 'p', 'dois', new Date(2026, 8, 22, 10))
    const list = await listHandoffs(cwd, 'p')
    expect(list.map((h) => [h.name, h.content])).toEqual([
      ['2026-09-22-01.md', 'um'],
      ['2026-09-22-02.md', 'dois'],
      ['2026-09-23-01.md', 'segundo dia']
    ])
    for (const h of list) {
      expect(Number.isInteger(h.createdAt)).toBe(true)
      expect(h.createdAt).toBeGreaterThan(before - 5_000)
    }
  })

  it('listHandoffs: NN numérico (10 depois de 9) e ignora pasta, não-.md e symlink', async () => {
    await createPlan(cwd, 'p', 'P')
    await fs.mkdir(handoffDir(), { recursive: true })
    await fs.writeFile(path.join(handoffDir(), '2026-09-22-10.md'), 'dez')
    await fs.writeFile(path.join(handoffDir(), '2026-09-22-09.md'), 'nove')
    await fs.writeFile(path.join(handoffDir(), '2026-09-22-100.md'), 'cem')
    await fs.writeFile(path.join(handoffDir(), 'rascunho.txt'), 'não')
    await fs.mkdir(path.join(handoffDir(), 'sub.md'))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-out-'))
    try {
      await fs.writeFile(path.join(outside, 'segredo.md'), 'fora')
      await fs.symlink(path.join(outside, 'segredo.md'), path.join(handoffDir(), 'link.md')).catch(() => undefined)
      const names = (await listHandoffs(cwd, 'p')).map((h) => h.name)
      expect(names).toEqual(['2026-09-22-09.md', '2026-09-22-10.md', '2026-09-22-100.md'])
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('listHandoffs recusa _handoff que escapa por symlink', async () => {
    await createPlan(cwd, 'p', 'P')
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-out-'))
    try {
      await fs.symlink(outside, handoffDir(), 'junction')
      await expect(listHandoffs(cwd, 'p')).rejects.toThrow(/symlink/)
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  it('writeHandoff só em planejamento que existe (não cria pasta solta)', async () => {
    await expect(writeHandoff(cwd, 'nada', 'x')).rejects.toBeInstanceOf(PlanNotFoundError)
    await expect(fs.stat(path.join(cwd, 'docs', 'spec', 'nada'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
