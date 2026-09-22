// @vitest-environment node
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { setPlanningChangeSink, type PlanningChangeNotice } from './planningEvents'
import type { Roteiro, StageStatus } from './planningModel'
import * as realStore from './planningStore'
import { createPlan, openPlan, type RoteiroDraft } from './planningStore'
import { buildPlanningTools, createPlanningMcpServer, PLANNING_TOOL_NAMES, type PlanningToolContext } from './planningTools'
import { isOwnWrite } from './planningWrites'

/**
 * Contra o planningStore REAL numa pasta temporária: as regras (rev otimista,
 * validação, caminho confinado) moram no store, e a ferramenta só traduz. Um
 * dublê provaria apenas que ela repassa argumentos.
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

const cardPath = (id: string): string => path.join(cwd, 'docs', 'spec', SLUG, 'cards', `${id}.md`)
const cardOf = async (id: string) => (await openPlan(cwd, SLUG)).cards.find((c) => c.id === id)

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
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-tools-'))
  await createPlan(cwd, SLUG, 'Checkout novo')
  notify = vi.fn<(change: PlanningChangeNotice) => void>()
  tools = build()
})

afterEach(async () => {
  setPlanningChangeSink(null)
  await fs.rm(cwd, { recursive: true, force: true })
})

describe('buildPlanningTools — contrato', () => {
  it('registra exatamente as ferramentas plan_* e nenhuma recebe slug ou pasta por argumento', () => {
    expect(tools.map((t) => t.name)).toEqual([...PLANNING_TOOL_NAMES])
    for (const t of tools) {
      const keys = Object.keys(t.inputSchema as Record<string, unknown>)
      expect(keys.filter((k) => /slug|cwd|project|dir|path/i.test(k)), t.name).toEqual([])
    }
  })

  it('createPlanningMcpServer expõe o servidor "planning"', () => {
    const server = createPlanningMcpServer({ projectCwd: cwd, slug: SLUG })
    expect(server).toMatchObject({ type: 'sdk', name: 'planning' })
  })

  it('slug e pasta vêm do contexto: argumento extra não desvia a gravação', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'planning-tools-other-'))
    try {
      await createPlan(other, 'outro', 'Outro')
      const out = await call('plan_card_create', { tipo: 'nota', titulo: 'Nota', id: 'n1', slug: 'outro', projectCwd: other })
      expect(out).toMatch(/Card criado: n1/)
      expect(await cardOf('n1')).toBeDefined()
      expect((await openPlan(other, 'outro')).cards).toEqual([])
    } finally {
      await fs.rm(other, { recursive: true, force: true })
    }
  })

  it('planejamento inexistente vira texto, não exceção', async () => {
    const lost = build({ slug: 'nao-existe' })
    expect(await call('plan_read', {}, lost)).toMatch(/plan_read falhou: planejamento não encontrado: nao-existe/)
    expect(notify).not.toHaveBeenCalled()
  })

  it('falha do store vira texto e não avisa a tela', async () => {
    const store = { ...realStore, saveRoteiro: vi.fn(async () => { throw new Error('EACCES: acesso negado') }) }
    const out = await call('plan_roteiro_set', { etapas: [{ id: 'a', titulo: 'A' }] }, build({ store }))
    expect(out).toBe('plan_roteiro_set falhou: EACCES: acesso negado')
    expect(notify).not.toHaveBeenCalled()
  })

  it('sem notify no contexto, o aviso sai pelo sink de planningEvents', async () => {
    const sink = vi.fn()
    setPlanningChangeSink(sink)
    await call('plan_card_create', { tipo: 'nota', titulo: 'Nota' }, build({ notify: undefined }))
    expect(sink).toHaveBeenCalledWith({ projectCwd: cwd, slug: SLUG })
  })
})

describe('roteiro', () => {
  it('plan_read de um planejamento vazio pede o roteiro primeiro', async () => {
    const out = await call('plan_read', {})
    expect(out).toMatch(/Planejamento checkout: Checkout novo/)
    expect(out).toMatch(/Roteiro: vazio — separe e ordene as etapas com plan_roteiro_set/)
  })

  it('plan_roteiro_set grava a lista ordenada, mantém status de etapa existente e avisa', async () => {
    await withRoteiro()
    await call('plan_etapa_marcar', { id: 'requisitos', status: 'concluida' })
    notify.mockClear()
    const out = await call('plan_roteiro_set', {
      titulo: 'Checkout v2',
      etapas: [
        { id: 'pagamento', titulo: 'Integrar pagamento' },
        { id: 'requisitos', titulo: 'Levantar requisitos' },
        { id: 'entrega', titulo: 'Entrega', status: 'em_andamento' }
      ]
    })
    expect(out).toMatch(/Roteiro gravado \(3 etapas\)/)
    const { roteiro } = await openPlan(cwd, SLUG)
    expect(roteiro).toEqual({
      titulo: 'Checkout v2',
      rev: 4, // createPlan 1 → withRoteiro 2 → etapa_marcar 3 → este 4
      etapas: [
        { id: 'pagamento', titulo: 'Integrar pagamento', status: 'pendente' },
        { id: 'requisitos', titulo: 'Levantar requisitos', status: 'concluida' },
        { id: 'entrega', titulo: 'Entrega', status: 'em_andamento' }
      ]
    })
    expect(notify).toHaveBeenCalledWith({ projectCwd: cwd, slug: SLUG })
  })

  it('plan_roteiro_set avisa sobre cards cuja etapa saiu do roteiro', async () => {
    await withRoteiro()
    await call('plan_card_create', { id: 'r1', tipo: 'requisito', titulo: 'R1', etapa: 'pagamento' })
    const out = await call('plan_roteiro_set', { etapas: [{ id: 'requisitos', titulo: 'Levantar requisitos' }] })
    expect(out).toMatch(/etapas que saíram do roteiro: r1/)
  })

  it('plan_roteiro_set com id inválido ou repetido falha sem gravar', async () => {
    const dup = await call('plan_roteiro_set', { etapas: [{ id: 'a', titulo: 'A' }, { id: 'a', titulo: 'B' }] })
    expect(dup).toMatch(/plan_roteiro_set falhou: etapa repetida: a/)
    expect(notify).not.toHaveBeenCalled()
  })

  it('plan_etapa_marcar muda uma etapa; etapa desconhecida ou mesmo status não gravam', async () => {
    await withRoteiro()
    expect(await call('plan_etapa_marcar', { id: 'pagamento', status: 'em_andamento' })).toBe(
      'Etapa pagamento agora está [em_andamento].'
    )
    expect((await openPlan(cwd, SLUG)).roteiro.etapas[1].status).toBe('em_andamento')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await call('plan_etapa_marcar', { id: 'pagamento', status: 'em_andamento' })).toMatch(/já estava/)
    expect(await call('plan_etapa_marcar', { id: 'xyz', status: 'concluida' })).toMatch(
      /Não existe etapa xyz no roteiro \(etapas: requisitos, pagamento\)/
    )
    expect(notify).toHaveBeenCalledTimes(1)
  })
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
      /Roteiro atual \(rev 3\): Checkout novo\n {2}1\. \[concluida\] requisitos: Levantar requisitos\n {2}2\. \[pendente\] pagamento: Integrar pagamento$/
    )
    expect(await statuses()).toEqual(['requisitos:concluida', 'pagamento:pendente'])
    expect(notify).not.toHaveBeenCalled()
  })

  it('roteiro gravado antes do rev (sem a linha) aceita as ferramentas e passa a ter rev', async () => {
    await fs.writeFile(path.join(cwd, 'docs', 'spec', SLUG, '_roteiro.md'), '# Antigo\n\n- [pendente] e1: Etapa um\n')
    expect(await call('plan_etapa_marcar', { id: 'e1', status: 'concluida' })).toBe('Etapa e1 agora está [concluida].')
    expect((await openPlan(cwd, SLUG)).roteiro).toMatchObject({ titulo: 'Antigo', rev: 1 })
  })
})

describe('cards', () => {
  it('plan_card_create grava pelo store (gravação própria) e avisa a tela', async () => {
    await withRoteiro()
    const out = await call('plan_card_create', {
      id: 'req-login',
      tipo: 'requisito',
      titulo: 'Login com e-mail',
      etapa: 'requisitos',
      corpo: 'Usuário entra com e-mail e senha.'
    })
    expect(out).toBe('Card criado: req-login [requisito] Login com e-mail · etapa requisitos · rev 1')
    const file = cardPath('req-login')
    expect(isOwnWrite(file, await fs.readFile(file))).toBe(true)
    expect(await cardOf('req-login')).toMatchObject({ rev: 1, corpo: 'Usuário entra com e-mail e senha.\n' })
    expect(notify).toHaveBeenCalledWith({ projectCwd: cwd, slug: SLUG })
  })

  it('sem id, deriva um livre do tipo e do título', async () => {
    expect(await call('plan_card_create', { tipo: 'decisao', titulo: 'Decisão: usar Postgres' })).toMatch(
      /Card criado: decisao-decisao-usar-postgres \[decisao\]/
    )
    expect(await call('plan_card_create', { tipo: 'decisao', titulo: 'Decisão: usar Postgres' })).toMatch(
      /Card criado: decisao-decisao-usar-postgres-2 \[decisao\]/
    )
  })

  it('id repetido não sobrescreve: devolve o rev atual e aponta plan_card_update', async () => {
    await call('plan_card_create', { id: 'n1', tipo: 'nota', titulo: 'Primeira' })
    notify.mockClear()
    const out = await call('plan_card_create', { id: 'n1', tipo: 'nota', titulo: 'Segunda' })
    expect(out).toMatch(/já existe o card n1 \(rev 1\).*plan_card_update com expected_rev=1/)
    expect((await cardOf('n1'))?.titulo).toBe('Primeira')
    expect(notify).not.toHaveBeenCalled()
  })

  it('sugestao sem fonte URL é recusada com mensagem clara e nada é gravado', async () => {
    for (const fonte of [undefined, 'ftp://x.org/a', 'minha cabeça']) {
      const out = await call('plan_card_create', { id: 's1', tipo: 'sugestao', titulo: 'Usar Stripe', fonte })
      expect(out, String(fonte)).toMatch(/Card não criado: card do tipo "sugestao" exige fonte: a URL http\/https/)
      expect(out).toMatch(/WebSearch\/WebFetch/)
    }
    await expect(fs.access(cardPath('s1'))).rejects.toThrow()
    expect(notify).not.toHaveBeenCalled()
    const ok = await call('plan_card_create', { id: 's1', tipo: 'sugestao', titulo: 'Usar Stripe', fonte: 'https://docs.stripe.com/payments' })
    expect(ok).toMatch(/Card criado: s1 \[sugestao\] Usar Stripe · fonte https:\/\/docs.stripe.com\/payments/)
  })

  it('etapa fora do roteiro e link para card inexistente são recusados', async () => {
    await withRoteiro()
    expect(await call('plan_card_create', { id: 'a', tipo: 'nota', titulo: 'A', etapa: 'nao-tem' })).toMatch(
      /a etapa "nao-tem" não está no roteiro/
    )
    expect(await call('plan_card_create', { id: 'a', tipo: 'nota', titulo: 'A', links: ['fantasma'] })).toMatch(
      /links para cards que não existem: fantasma/
    )
    expect(notify).not.toHaveBeenCalled()
  })

  it('plan_card_update aplica com o rev certo; null remove campo', async () => {
    await withRoteiro()
    await call('plan_card_create', { id: 'r1', tipo: 'requisito', titulo: 'R1', etapa: 'requisitos' })
    const out = await call('plan_card_update', { id: 'r1', expected_rev: 1, titulo: 'R1 revisado', etapa: null, corpo: 'novo' })
    expect(out).toBe('Card atualizado: r1 [requisito] R1 revisado · rev 2')
    const card = await cardOf('r1')
    expect(card).toMatchObject({ titulo: 'R1 revisado', corpo: 'novo\n', rev: 2 })
    expect(card?.etapa).toBeUndefined()
  })

  it('plan_card_update com rev desatualizado não grava e devolve o card atual', async () => {
    await call('plan_card_create', { id: 'r1', tipo: 'requisito', titulo: 'R1', corpo: 'versão da tela' })
    await call('plan_card_update', { id: 'r1', expected_rev: 1, titulo: 'R1 pela tela' })
    notify.mockClear()
    const out = await call('plan_card_update', { id: 'r1', expected_rev: 1, titulo: 'R1 velho' })
    expect(out).toMatch(/plan_card_update falhou: rev desatualizado: esperado 1, atual 2/)
    expect(out).toMatch(/expected_rev=2/)
    expect(out).toMatch(/Card atual:\nr1 \[requisito\] R1 pela tela · rev 2\n---\nversão da tela/)
    expect((await cardOf('r1'))?.titulo).toBe('R1 pela tela')
    expect(notify).not.toHaveBeenCalled()
    expect(await call('plan_card_update', { id: 'zzz', expected_rev: 0, titulo: 'x' })).toMatch(/Não existe card zzz/)
  })

  it('plan_card_update não deixa uma sugestao perder a fonte', async () => {
    await call('plan_card_create', { id: 's1', tipo: 'sugestao', titulo: 'S', fonte: 'https://example.com' })
    expect(await call('plan_card_update', { id: 's1', expected_rev: 1, fonte: null })).toMatch(/Card não alterado: card do tipo "sugestao" exige fonte/)
    expect((await cardOf('s1'))?.fonte).toBe('https://example.com')
  })

  it('plan_card_delete exige o rev certo e lista quem ainda aponta para o card', async () => {
    await call('plan_card_create', { id: 'alvo', tipo: 'nota', titulo: 'Alvo' })
    await call('plan_card_create', { id: 'fonte-a', tipo: 'nota', titulo: 'A', links: ['alvo'] })
    notify.mockClear()
    expect(await call('plan_card_delete', { id: 'alvo', expected_rev: 7 })).toMatch(
      /plan_card_delete falhou: rev desatualizado: esperado 7, atual 1[\s\S]*Card atual:\nalvo \[nota\] Alvo/
    )
    expect(notify).not.toHaveBeenCalled()
    const out = await call('plan_card_delete', { id: 'alvo', expected_rev: 1 })
    expect(out).toMatch(/Card alvo apagado\. Estes cards ainda apontam para ele: fonte-a/)
    await expect(fs.access(cardPath('alvo'))).rejects.toThrow()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await call('plan_card_delete', { id: 'alvo', expected_rev: 1 })).toMatch(/O card não existe/)
  })

  it('plan_card_link adiciona e remove, sem gravar quando nada muda', async () => {
    await call('plan_card_create', { id: 'a', tipo: 'nota', titulo: 'A' })
    await call('plan_card_create', { id: 'b', tipo: 'nota', titulo: 'B' })
    notify.mockClear()
    expect(await call('plan_card_link', { de: 'a', para: 'b' })).toBe('Ligação criada: a [nota] A · links b · rev 2')
    expect(await call('plan_card_link', { de: 'a', para: 'b' })).toMatch(/já aponta para b; nada gravado/)
    expect(await call('plan_card_link', { de: 'a', para: 'nao-tem' })).toMatch(/Não existe card nao-tem/)
    expect(await call('plan_card_link', { de: 'a', para: 'a' })).toMatch(/não pode apontar para ele mesmo/)
    expect(await call('plan_card_link', { de: 'a', para: 'b', acao: 'remover', expected_rev: 1 })).toMatch(
      /rev desatualizado: esperado 1, atual 2/
    )
    expect(await call('plan_card_link', { de: 'a', para: 'b', acao: 'remover' })).toBe('Ligação removida: a [nota] A · rev 3')
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('plan_read resume roteiro, cards e inválidos; card_id traz o card inteiro', async () => {
    await withRoteiro()
    await call('plan_card_create', { id: 'r1', tipo: 'requisito', titulo: 'R1', etapa: 'requisitos', corpo: 'Linha 1\nLinha 2' })
    await fs.writeFile(cardPath('quebrado'), 'sem frontmatter', 'utf8')
    const out = await call('plan_read', {})
    expect(out).toMatch(/Roteiro \(2 etapas, na ordem\):\n {2}1\. \[pendente\] requisitos: Levantar requisitos/)
    expect(out).toMatch(/- r1 \[requisito\] R1 · etapa requisitos · rev 1 — Linha 1 Linha 2/)
    expect(out).toMatch(/Arquivos inválidos \(1\)[\s\S]*cards\/quebrado\.md: card sem frontmatter/)
    expect(await call('plan_read', { card_id: 'r1' })).toBe('r1 [requisito] R1 · etapa requisitos · rev 1\n---\nLinha 1\nLinha 2')
    expect(await call('plan_read', { card_id: 'x' })).toMatch(/Não existe card x/)
  })
})

describe('ambiguidades e handoff', () => {
  it('plan_ambiguidade_abrir cria card aberto, ligado aos envolvidos, com a opinião do Manager', async () => {
    await call('plan_card_create', { id: 'r1', tipo: 'requisito', titulo: 'Frete grátis' })
    notify.mockClear()
    const out = await call('plan_ambiguidade_abrir', {
      id: 'amb-frete',
      titulo: 'Frete grátis vale para todo o país?',
      contexto: 'O pedido diz "frete grátis" sem dizer onde.',
      opiniao: 'Só capitais no início: o custo no interior é 3x.',
      envolvidos: ['r1']
    })
    expect(out).toMatch(/Card criado: amb-frete \[ambiguidade\] .* · status aberta · links r1 · rev 1/)
    const card = await cardOf('amb-frete')
    expect(card).toMatchObject({ tipo: 'ambiguidade', status: 'aberta', links: ['r1'] })
    expect(card?.corpo).toMatch(/## Cards envolvidos\n\n- \[\[r1\]\] — Frete grátis/)
    expect(card?.corpo).toMatch(/## Opinião do Manager\n\nSó capitais no início/)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(
      await call('plan_ambiguidade_abrir', { titulo: 'X?', contexto: 'c', opiniao: 'o', envolvidos: ['fantasma'] })
    ).toMatch(/links para cards que não existem: fantasma/)
  })

  it('plan_ambiguidade_resolver marca resolvida e registra a decisão no corpo', async () => {
    await call('plan_ambiguidade_abrir', { id: 'amb', titulo: 'A ou B?', contexto: 'c', opiniao: 'A' })
    await call('plan_card_create', { id: 'n1', tipo: 'nota', titulo: 'Nota' })
    notify.mockClear()
    expect(await call('plan_ambiguidade_resolver', { id: 'n1', expected_rev: 1, decisao: 'x' })).toMatch(/não ambiguidade/)
    expect(await call('plan_ambiguidade_resolver', { id: 'amb', expected_rev: 0, decisao: 'x' })).toMatch(/rev desatualizado/)
    const out = await call('plan_ambiguidade_resolver', { id: 'amb', expected_rev: 1, decisao: 'O usuário escolheu B.' })
    expect(out).toMatch(/Ambiguidade resolvida: amb \[ambiguidade\] A ou B\? · status resolvida · rev 2/)
    const card = await cardOf('amb')
    expect(card?.status).toBe('resolvida')
    expect(card?.corpo).toMatch(/## Opinião do Manager\n\nA\n\n## Decisão \(2026-09-22\)\n\nO usuário escolheu B\.\n$/)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await call('plan_ambiguidade_resolver', { id: 'amb', expected_rev: 2, decisao: 'y' })).toMatch(/já está resolvida/)
  })

  it('plan_handoff_write grava em _handoff/ pelo store e devolve o caminho', async () => {
    const out = await call('plan_handoff_write', { conteudo: '# Implementar checkout\n' })
    const expected = path.join(cwd, 'docs', 'spec', SLUG, '_handoff', '2026-09-22-01.md')
    expect(out).toBe(`Handoff gravado em ${expected}`)
    expect(await fs.readFile(expected, 'utf8')).toBe('# Implementar checkout\n')
    expect(notify).toHaveBeenCalledWith({ projectCwd: cwd, slug: SLUG })
    expect(await call('plan_handoff_write', { conteudo: 'segundo' })).toMatch(/2026-09-22-02\.md$/)
  })
})
