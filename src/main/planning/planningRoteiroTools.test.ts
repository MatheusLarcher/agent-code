// @vitest-environment node
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PlanningChangeNotice } from './planningEvents'
import type { Roteiro, StageStatus } from './planningModel'
import * as realStore from './planningStore'
import { createPlan, listHandoffs, openPlan, type RoteiroDraft } from './planningStore'
import { buildPlanningTools, type PlanningToolContext } from './planningTools'

/**
 * As ferramentas de planningRoteiroTools (roteiro e handoff), pelo
 * buildPlanningTools e contra o planningStore REAL numa pasta temporária, como
 * em planningTools.test.ts: a corrida de rev com a tela e as etapas de cada
 * prompt de handoff.
 */

type Tool = ReturnType<typeof buildPlanningTools>[number]
type Result = { content: { type: string; text?: string }[] }

const SLUG = 'checkout'
let cwd: string
let notify: Mock<(change: PlanningChangeNotice) => void>
let tools: Tool[]

function build(over: Partial<PlanningToolContext> = {}): Tool[] {
  return buildPlanningTools({ projectCwd: cwd, slug: SLUG, notify, now: () => new Date(2026, 8, 22, 10), ...over })
}

async function call(name: string, args: unknown, list: Tool[] = tools): Promise<string> {
  const found = list.find((t) => t.name === name)
  if (!found) throw new Error(`tool ${name} não registrada`)
  const result = (await found.handler(args as never, undefined)) as Result
  return result.content.map((part) => part.text ?? '').join('\n')
}

async function withRoteiro(): Promise<void> {
  await call('plan_roteiro_set', {
    etapas: [
      { id: 'requisitos', titulo: 'Levantar requisitos' },
      { id: 'pagamento', titulo: 'Integrar pagamento' }
    ]
  })
  notify.mockClear()
}

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-roteiro-tools-'))
  await createPlan(cwd, SLUG, 'Checkout novo')
  notify = vi.fn<(change: PlanningChangeNotice) => void>()
  tools = build()
})

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true })
})

/**
 * Store real, mas nas `times` primeiras gravações do roteiro pela ferramenta
 * "a tela" grava antes, por fora, `race(roteiro em disco)`: a corrida real.
 */
function racingStore(race: (r: Roteiro) => RoteiroDraft, times = 1) {
  let left = times
  const saveRoteiro = vi.fn(async (c: string, s: string, roteiro: RoteiroDraft, expectedRev: number) => {
    if (left-- > 0) {
      const disk = (await openPlan(c, s)).roteiro
      await realStore.saveRoteiro(c, s, race(disk), disk.rev)
    }
    return realStore.saveRoteiro(c, s, roteiro, expectedRev)
  })
  return { store: { ...realStore, saveRoteiro }, saveRoteiro }
}

const setStatus = (r: Roteiro, id: string, status: StageStatus): RoteiroDraft => ({
  ...r,
  etapas: r.etapas.map((e) => (e.id === id ? { ...e, status } : e))
})
const statuses = async (): Promise<string[]> =>
  (await openPlan(cwd, SLUG)).roteiro.etapas.map((e) => `${e.id}:${e.status}`)

describe('roteiro — rev e corrida com a tela', () => {
  it('plan_etapa_marcar em conflito relê e reaplica UMA vez, sem perder a mudança da tela', async () => {
    await withRoteiro() // rev 2
    const { store, saveRoteiro } = racingStore((r) => setStatus(r, 'requisitos', 'concluida'))
    const out = await call('plan_etapa_marcar', { id: 'pagamento', status: 'em_andamento' }, build({ store }))
    expect(out).toBe('Etapa pagamento agora está [em_andamento].')
    expect(saveRoteiro.mock.calls.map((c) => c[3])).toEqual([2, 3]) // o rev lido, depois o relido
    expect(await statuses()).toEqual(['requisitos:concluida', 'pagamento:em_andamento'])
    expect((await openPlan(cwd, SLUG)).roteiro.rev).toBe(4)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('plan_etapa_marcar não insiste depois do segundo conflito: devolve o roteiro atual', async () => {
    await withRoteiro()
    const { store, saveRoteiro } = racingStore((r) => ({ ...r, titulo: `${r.titulo} +` }), 2)
    const out = await call('plan_etapa_marcar', { id: 'pagamento', status: 'concluida' }, build({ store }))
    expect(saveRoteiro).toHaveBeenCalledTimes(2)
    expect(out).toMatch(/^plan_etapa_marcar falhou: rev do roteiro desatualizado: esperado 3, atual 4\. Nada foi gravado/)
    expect(out).toMatch(/Roteiro atual \(rev 4\): Checkout novo \+ \+\n {2}1\. \[pendente\] requisitos: Levantar requisitos/)
    expect(await statuses()).toEqual(['requisitos:pendente', 'pagamento:pendente'])
    expect(notify).not.toHaveBeenCalled()
  })

  it('plan_etapa_marcar: se a etapa sumiu no meio, não grava e explica', async () => {
    await withRoteiro()
    const { store, saveRoteiro } = racingStore((r) => ({ ...r, etapas: r.etapas.filter((e) => e.id !== 'pagamento') }))
    const out = await call('plan_etapa_marcar', { id: 'pagamento', status: 'concluida' }, build({ store }))
    expect(out).toBe('O roteiro mudou enquanto você marcava. Não existe etapa pagamento no roteiro (etapas: requisitos).')
    expect(saveRoteiro).toHaveBeenCalledTimes(1)
    expect(notify).not.toHaveBeenCalled()
  })

  it('plan_roteiro_set grava com o rev lido; em conflito não grava e devolve o roteiro atual para refazer', async () => {
    await withRoteiro()
    const { store, saveRoteiro } = racingStore((r) => setStatus(r, 'requisitos', 'concluida'))
    const out = await call(
      'plan_roteiro_set',
      {
        etapas: [
          { id: 'requisitos', titulo: 'Levantar requisitos' },
          { id: 'pagamento', titulo: 'Integrar pagamento' },
          { id: 'entrega', titulo: 'Entrega' }
        ]
      },
      build({ store })
    )
    expect(saveRoteiro).toHaveBeenCalledTimes(1)
    expect(saveRoteiro.mock.calls[0][3]).toBe(2)
    expect(out).toMatch(/^plan_roteiro_set falhou: rev do roteiro desatualizado: esperado 2, atual 3\. Nada foi gravado/)
    expect(out).toMatch(/mande de novo a lista inteira/)
    expect(out).toMatch(
      /Roteiro atual \(rev 3\): Checkout novo\n {2}1\. \[concluida\] requisitos: Levantar requisitos \(sem estimativa\)\n {2}2\. \[pendente\] pagamento: Integrar pagamento \(sem estimativa\)$/
    )
    expect(await statuses()).toEqual(['requisitos:concluida', 'pagamento:pendente'])
    expect(notify).not.toHaveBeenCalled()
  })

  it('roteiro gravado antes do rev (sem a linha) aceita as ferramentas e passa a ter rev', async () => {
    await fs.writeFile(path.join(cwd, 'docs', 'spec', SLUG, '_roteiro.md'), '# Antigo\n\n- [pendente] e1: Etapa um\n')
    expect(await call('plan_etapa_marcar', { id: 'e1', status: 'concluida' })).toBe('Etapa e1 agora está [concluida].')
    expect((await openPlan(cwd, SLUG)).roteiro).toMatchObject({ titulo: 'Antigo', rev: 1 })
  })

  it('plan_etapa_marcar preserva a estimativa da etapa', async () => {
    await call('plan_roteiro_set', { etapas: [{ id: 'a', titulo: 'A', estimativa: 40 }] })
    expect(await call('plan_etapa_marcar', { id: 'a', status: 'concluida' })).toBe('Etapa a agora está [concluida].')
    expect((await openPlan(cwd, SLUG)).roteiro.etapas).toEqual([{ id: 'a', titulo: 'A', status: 'concluida', estimativa: 40 }])
  })
})

describe('plan_handoff_write — etapas de cada prompt', () => {
  const handoffDir = (): string => path.join(cwd, 'docs', 'spec', SLUG, '_handoff')

  beforeEach(async () => {
    await call('plan_roteiro_set', {
      etapas: [
        { id: 'requisitos', titulo: 'Levantar requisitos', estimativa: 45 },
        { id: 'pagamento', titulo: 'Integrar pagamento', estimativa: 90 },
        { id: 'entrega', titulo: 'Entrega' }
      ]
    })
    notify.mockClear()
  })

  it('grava o .md pelo store, as etapas em <base>.meta.json ao lado e devolve o caminho com o total do prompt', async () => {
    const out = await call('plan_handoff_write', { conteudo: '# Implementar checkout\n', etapas: ['pagamento', 'requisitos'] })
    const expected = path.join(handoffDir(), '2026-09-22-01.md')
    expect(out).toBe(
      `Handoff gravado em ${expected}\n` +
        'Etapas deste prompt (2): pagamento (est. 90 min = 1 h 30 min), requisitos (est. 45 min). ' +
        'Estimativa total do prompt: 135 min = 2 h 15 min.'
    )
    expect(await fs.readFile(expected, 'utf8')).toBe('# Implementar checkout\n') // o texto não leva as etapas
    expect(JSON.parse(await fs.readFile(path.join(handoffDir(), '2026-09-22-01.meta.json'), 'utf8'))).toEqual({
      etapas: ['pagamento', 'requisitos']
    })
    expect(notify).toHaveBeenCalledWith({ projectCwd: cwd, slug: SLUG })
    expect(await call('plan_handoff_write', { conteudo: 'segundo', etapas: ['entrega'] })).toMatch(
      /2026-09-22-02\.md\nEtapas deste prompt \(1\): entrega \(sem estimativa\)\. Estimativa total do prompt: 0 min — 1 etapa sem estimativa\.$/
    )
    expect((await listHandoffs(cwd, SLUG)).map((h) => [h.name, h.etapas])).toEqual([
      ['2026-09-22-01.md', ['pagamento', 'requisitos']],
      ['2026-09-22-02.md', ['entrega']]
    ])
  })

  it('exige etapas: ids do roteiro, sem repetir; senão nada é gravado', async () => {
    const etapasSchema = (tools.find((t) => t.name === 'plan_handoff_write')?.inputSchema as Record<string, { safeParse(v: unknown): { success: boolean } }>).etapas
    for (const bad of [undefined, [], ['A'], Array.from({ length: 101 }, (_, i) => `e${i}`)]) {
      expect(etapasSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    }
    expect(await call('plan_handoff_write', { conteudo: 'x', etapas: ['requisitos', 'requisitos'] })).toBe(
      'Handoff não gravado: etapa repetida em "etapas": requisitos.'
    )
    expect(await call('plan_handoff_write', { conteudo: 'x', etapas: ['requisitos', 'fantasma'] })).toBe(
      'Handoff não gravado: etapas que não estão no roteiro: fantasma (etapas: requisitos, pagamento, entrega).'
    )
    await expect(fs.stat(handoffDir())).rejects.toMatchObject({ code: 'ENOENT' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('falha ao gravar as etapas não deixa o .md sozinho', async () => {
    // Uma pasta no lugar do .meta.json faz a gravação dele falhar.
    await fs.mkdir(path.join(handoffDir(), '2026-09-22-01.meta.json'), { recursive: true })
    const out = await call('plan_handoff_write', { conteudo: 'x', etapas: ['entrega'] })
    expect(out).toMatch(/^plan_handoff_write falhou: /)
    expect((await fs.readdir(handoffDir())).filter((n) => n.endsWith('.md'))).toEqual([])
    expect(notify).not.toHaveBeenCalled()
  })
})
