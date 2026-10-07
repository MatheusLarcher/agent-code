// @vitest-environment node
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandoffProjectSnapshot } from '../../shared/handoffProject'
import type { HandoffEnvio, HandoffQueueDecision } from '../../shared/handoffTracking'
import type { ChatEvent, TaskItem } from '../../shared/ipc'
import { Channels } from '../../shared/ipc'
import type { HandoffQueueListResult } from '../../shared/api'
import { closeHarnesses, harness, type Harness } from './handoffTrackerHarness'
import { registerHandoffQueueIpc, type HandoffQueueIpcListener } from './handoffQueueIpc'
import type { ProjectEvaluationInput, ProjectEvaluationOutcome } from './projectQueueEvaluation'
import { PROJECT_REEVALUATE_MS, PROJECT_STOP_WAIT_MS } from './projectQueueRules'
import { ProjectQueueService } from './projectQueueService'
import { ProjectQueueStore } from './projectQueueStore'

/**
 * A fila do projeto de ponta a ponta (tracker, Quadro e SQLite de verdade; git
 * e PO simulados): um plano por vez na pasta, sem intercalar; pastas diferentes
 * não se seguram; a pasta suja segura com "Começar mesmo assim"; parado 30 min,
 * o PO decide a vez; a resposta do usuário no A com o B na vez fica guardada e
 * o PO decide RETOMAR_A/ESPERAR_B/PERGUNTAR. O usuário vence sempre.
 */

afterEach(closeHarnesses)

const turnStart: ChatEvent = { kind: 'turn-start', turnIds: ['u1'] }
const result: ChatEvent = { kind: 'result', id: 'r1', isError: false, text: 'Pronto.', durationMs: 1 }

interface Setup {
  h: Harness
  service: ProjectQueueService
  git: { dirty: string[]; head: string }
  evaluate: ReturnType<typeof vi.fn<(input: ProjectEvaluationInput) => Promise<ProjectEvaluationOutcome>>>
  notified: string[]
  last(): HandoffProjectSnapshot
  plan(lote: string, conv: string, titulo: string, etapas: string[], cwd?: string): Promise<HandoffEnvio[]>
  next(conv: string): Promise<HandoffQueueDecision>
  turn(conv: string, tasks: Array<[string, TaskItem['status']]>, opts?: { end?: boolean }): Promise<void>
  refresh(cwd?: string): Promise<void>
}

const verdict = (decisao: ProjectEvaluationOutcome['decisao'], motivo = 'porque sim'): ProjectEvaluationOutcome => ({
  cancelled: false,
  decisao,
  motivo,
  ...(decisao === 'PERGUNTAR' ? { pergunta: motivo } : {}),
  falhou: false,
  alterados: [],
  registro: null
})

async function setup(): Promise<Setup> {
  let service!: ProjectQueueService
  const h = await harness({ attach: false, deps: { onChanged: (conv) => service?.changed(conv) } })
  const git = { dirty: [] as string[], head: 'c0' }
  const notified: string[] = []
  let snapshot: HandoffProjectSnapshot | null = null
  const evaluate = vi.fn<(input: ProjectEvaluationInput) => Promise<ProjectEvaluationOutcome>>(async () => verdict('ESPERAR'))
  service = new ProjectQueueService({
    repository: () => h.repo,
    store: new ProjectQueueStore(null),
    git: { dirty: async () => [...git.dirty], head: async () => git.head, snapshot: async () => new Map() },
    evaluate,
    notify: (conv) => notified.push(conv),
    publish: (next) => {
      snapshot = next
    },
    now: () => h.now(),
    caseInsensitive: true,
    debounceMs: 1
  })
  const settleConv = async (conv: string): Promise<void> => {
    for (let i = 0; i < 4; i++) {
      await h.board.settled(conv)
      await h.board.turnClosed(conv)
      await h.tracker.settled()
    }
  }
  const s: Setup = {
    h,
    service,
    git,
    evaluate,
    notified,
    last: () => snapshot!,
    async plan(lote, conv, titulo, etapas, cwd = h.cwd) {
      const envios = await h.repo.createHandoffEnvios(
        etapas.map((etapa, i) => ({
          planSlug: lote,
          planTitulo: titulo,
          projectId: h.projectId,
          projectCwd: cwd,
          conversationId: conv,
          conversationTitle: `Implementação: ${titulo}`,
          arquivo: `2026-10-06-0${i + 1}.md`,
          ordem: i + 1,
          loteId: lote,
          conteudo: `Prompt ${i + 1} de ${titulo}`,
          entregas: [{ etapaId: etapa, etapaTitulo: `Etapa ${etapa}`, estimativaPlano: 30 }]
        }))
      )
      h.tracker.attach(conv, cwd)
      h.tracker.onRegistered(envios)
      await service.addPlan(envios)
      return envios
    },
    // O que o despachante do renderer faz: pergunta ao gate e, com "next", marca pelo id e manda.
    async next(conv) {
      await settleConv(conv)
      const decision = await service.gate(conv, await h.repo.listHandoffEnvios({ conversationId: conv }))
      if (decision.kind === 'next') {
        await h.tracker.dispatched(conv, decision.envio.id)
        h.tracker.noteUserSend(conv, decision.envio.conteudo)
      }
      return decision
    },
    async turn(conv, tasks, opts = {}) {
      h.advance(1_000)
      h.emit(turnStart, conv)
      h.tasks(tasks, conv)
      if (opts.end !== false) {
        h.advance(1_000)
        h.emit(result, conv)
      }
      await settleConv(conv)
      await s.refresh()
    },
    async refresh(cwd = h.cwd) {
      await h.tracker.settled()
      await service.refresh(service.key(cwd))
    }
  }
  return s
}

const motivo = (d: HandoffQueueDecision): string => (d.kind === 'hold' ? d.motivo : `(${d.kind})`)

describe('a fila do projeto — um plano por vez na pasta', () => {
  it('o B espera o A na mesma pasta; outra pasta não se segura; planos não se intercalam', async () => {
    const s = await setup()
    await s.plan('la', 'conv-a', 'Plano A', ['a1', 'a2'])
    await s.plan('lb', 'conv-b', 'Plano B', ['b1'])
    await s.plan('lc', 'conv-c', 'Plano C', ['c1'], join(s.h.cwd, '..', 'outra-pasta'))

    expect(await s.next('conv-a')).toMatchObject({ kind: 'next', envio: { conteudo: 'Prompt 1 de Plano A' } })
    expect(motivo(await s.next('conv-b'))).toBe('na fila do projeto (2º): esperando o plano "Plano A" terminar')
    // Outra pasta neste PC: fila própria, começa já.
    expect(await s.next('conv-c')).toMatchObject({ kind: 'next', envio: { conteudo: 'Prompt 1 de Plano C' } })

    // O 1º prompt do A conclui: sai o 2º do A — nunca o 1º do B no meio.
    await s.turn('conv-a', [['[a1] Etapa a1', 'completed']])
    expect(await s.next('conv-b')).toMatchObject({ kind: 'hold' })
    expect(await s.next('conv-a')).toMatchObject({ kind: 'next', envio: { conteudo: 'Prompt 2 de Plano A' } })
    expect(await s.next('conv-b')).toMatchObject({ kind: 'hold' })

    // O A termina: a pasta avisa o B, que começa.
    s.notified.length = 0
    await s.turn('conv-a', [
      ['[a1] Etapa a1', 'completed'],
      ['[a2] Etapa a2', 'completed']
    ])
    expect(s.notified).toContain('conv-b')
    expect(await s.next('conv-b')).toMatchObject({ kind: 'next', envio: { conteudo: 'Prompt 1 de Plano B' } })
    expect(s.last().folders.find((f) => f.cwd === s.h.cwd)?.plans.map((p) => p.planTitulo)).toEqual(['Plano B'])
  })

  it('a pasta suja segura o começo com "N arquivos sem commit"; "Começar mesmo assim" solta', async () => {
    const s = await setup()
    s.git.dirty = ['src/x.ts', 'src/y.ts']
    await s.plan('la', 'conv-a', 'Plano A', ['a1'])
    expect(motivo(await s.next('conv-a'))).toBe('2 arquivos sem commit nesta pasta')
    expect(s.last().folders[0].plans[0]).toMatchObject({ sujo: 2, comecou: false })
    expect(await s.service.action('conv-a', 'comecar')).toEqual({ ok: true })
    expect(await s.next('conv-a')).toMatchObject({ kind: 'next' })
    expect(s.last().folders[0].plans[0]).toMatchObject({ comecarMesmoAssim: 'usuario', sujo: null })
  })

  it('a faixa reordena planos inteiros (quem fica na frente tem a vez) e mostra o que o plano parado deixou sem commit', async () => {
    const s = await setup()
    await s.plan('la', 'conv-a', 'Plano A', ['a1'])
    await s.plan('lb', 'conv-b', 'Plano B', ['b1'])
    expect(await s.service.reorder(s.h.cwd, ['lb', 'la'])).toEqual({ ok: true })
    expect(s.last().folders[0].plans.map((p) => p.planTitulo)).toEqual(['Plano B', 'Plano A'])
    expect(await s.next('conv-b')).toMatchObject({ kind: 'next' })
    expect(motivo(await s.next('conv-a'))).toMatch(/esperando o (plano|prompt atual do plano) "Plano B"/)
    s.git.dirty = ['src/a.ts']
    expect(await s.service.dirtyFiles('conv-a')).toEqual(['src/a.ts'])
    expect(await s.service.reorder(join(s.h.cwd, '..', 'sem-fila'), ['lb'])).toMatchObject({ ok: false })
  })

  it('a faixa vê a mesma fila: posição do plano e o motivo, sem rodar o git', async () => {
    const s = await setup()
    await s.plan('la', 'conv-a', 'Plano A', ['a1'])
    await s.plan('lb', 'conv-b', 'Plano B', ['b1', 'b2'])
    await s.next('conv-a')
    const handlers = new Map<string, HandoffQueueIpcListener>()
    registerHandoffQueueIpc({ handle: (c, l) => handlers.set(c, l), repository: () => s.h.repo, tracker: s.h.tracker, project: s.service })
    const list = (await handlers.get(Channels.handoffQueueList)!(null, { projectCwd: s.h.cwd })) as HandoffQueueListResult
    expect(list).toMatchObject({
      ok: true,
      items: [
        { conversationId: 'conv-b', ordem: 1, planPosicao: 2, estado: 'esperando', motivo: 'na fila do projeto (2º): esperando o plano "Plano A" terminar' },
        { conversationId: 'conv-b', ordem: 2, planPosicao: 2, estado: 'esperando', motivo: null }
      ]
    })
  })
})

/** O A parado (prompt 1 incompleto) e o B esperando atrás dele. */
async function stoppedA(s: Setup): Promise<void> {
  await s.plan('la', 'conv-a', 'Plano A', ['a1', 'a2'])
  await s.plan('lb', 'conv-b', 'Plano B', ['b1'])
  await s.next('conv-a')
  await s.turn('conv-a', [['[a1] Etapa a1', 'in_progress']])
  expect((await s.h.repo.listHandoffEnvios({ conversationId: 'conv-a' })).find((e) => e.ordem === 1)?.status).toBe('incompleta')
}

describe('o PO decide a vez depois de 30 min parado (SDK simulado)', () => {
  it('30 min → avaliação; COMECAR com a pasta suja leva a lista dos arquivos do A no 1º prompt do B', async () => {
    const s = await setup()
    await stoppedA(s)
    await s.service.tick()
    s.h.advance(PROJECT_STOP_WAIT_MS - 1)
    await s.service.tick()
    expect(s.evaluate).not.toHaveBeenCalled()

    s.git.dirty = ['src/App.tsx', 'src/novo.ts']
    s.evaluate.mockResolvedValueOnce(verdict('COMECAR', 'o B não toca no que o A deixou'))
    s.h.advance(1)
    await s.service.tick()
    await vi.waitFor(() => expect(s.last().folders[0].avaliacao?.decisao).toBe('COMECAR'))
    const input = s.evaluate.mock.calls[0][0]
    expect(input).toMatchObject({ kind: 'vez', a: { plan: { loteId: 'la' } }, b: { plan: { loteId: 'lb' } } })
    expect(input.a.motivo).toMatch(/não foi concluído/)

    const decision = await s.next('conv-b')
    if (decision.kind !== 'next') throw new Error(`esperava o 1º prompt do B: ${motivo(decision)}`)
    expect(decision.envio.conteudo).toContain('NÃO edite nem commite estes arquivos')
    expect(decision.envio.conteudo).toContain('- src/App.tsx\n- src/novo.ts')
    expect(decision.envio.conteudo.endsWith('Prompt 1 de Plano B')).toBe(true)
    expect(s.last().folders[0].plans[0]).toMatchObject({ planTitulo: 'Plano B', comecarMesmoAssim: 'po', arquivosDoAnterior: ['src/App.tsx', 'src/novo.ts'] })
    // O A não roda junto: o prompt seguinte dele espera.
    expect(motivo(await s.next('conv-a'))).toMatch(/esperando o plano "Plano B" terminar|esperando o prompt atual do plano "Plano B"/)
  })

  it('ESPERAR fica; reavalia só com algo mudado e no máximo a cada 30 min; falha → ESPERAR', async () => {
    const s = await setup()
    await stoppedA(s)
    await s.service.tick()
    s.h.advance(PROJECT_STOP_WAIT_MS)
    await s.service.tick()
    await vi.waitFor(() => expect(s.last().folders[0].avaliacao?.decisao).toBe('ESPERAR'))
    expect(s.evaluate).toHaveBeenCalledTimes(1)

    s.h.advance(PROJECT_REEVALUATE_MS)
    await s.service.tick()
    expect(s.evaluate).toHaveBeenCalledTimes(1) // nada mudou

    s.git.head = 'c1' // um commit novo
    s.h.advance(1_000)
    s.evaluate.mockRejectedValueOnce(new Error('SDK caiu'))
    await s.service.tick()
    await vi.waitFor(() => expect(s.evaluate).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(s.last().folders[0].avaliacao).toMatchObject({ decisao: 'ESPERAR', falhou: true }))
    expect(motivo(await s.next('conv-b'))).toMatch(/^na fila do projeto \(2º\)/)
  })

  it('o usuário responde no A durante a avaliação: ela é cancelada e não decide nada', async () => {
    const s = await setup()
    await stoppedA(s)
    let release!: () => void
    s.evaluate.mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          release = () => resolve({ ...verdict('COMECAR'), cancelled: input.signal.aborted })
          input.signal.addEventListener('abort', () => release())
        })
    )
    await s.service.tick()
    s.h.advance(PROJECT_STOP_WAIT_MS)
    await s.service.tick()
    await vi.waitFor(() => expect(s.last().folders[0].avaliando).toBe('vez'))
    // A resposta do usuário abre um turno no A.
    await s.turn('conv-a', [['[a1] Etapa a1', 'in_progress']], { end: false })
    await vi.waitFor(() => expect(s.last().folders[0].avaliando).toBeNull())
    expect(s.last().folders[0].avaliacao).toBeNull()
    expect(s.last().folders[0].plans[0].planTitulo).toBe('Plano A')
  })
})

/** O A parado, o B com a vez ("Começar mesmo assim") e rodando o 1º prompt. */
async function bRunning(s: Setup): Promise<void> {
  await s.plan('la', 'conv-a', 'Plano A', ['a1', 'a2'])
  await s.plan('lb', 'conv-b', 'Plano B', ['b1', 'b2'])
  await s.next('conv-a')
  await s.turn('conv-a', [['[a1] Etapa a1', 'in_progress']])
  await s.service.action('conv-b', 'comecar')
  expect(await s.next('conv-b')).toMatchObject({ kind: 'next' })
  await s.turn('conv-b', [['[b1] Etapa b1', 'in_progress']], { end: false })
  expect(s.last().folders[0].plans.map((p) => [p.planTitulo, p.estado])).toEqual([
    ['Plano B', 'rodando'],
    ['Plano A', 'parado']
  ])
}

describe('o usuário respondeu o A com o B rodando (SDK simulado)', () => {
  it('a resposta fica guardada e o PO decide RETOMAR_A: o A volta no fim do prompt atual do B', async () => {
    const s = await setup()
    await bRunning(s)
    s.evaluate.mockResolvedValueOnce(verdict('RETOMAR_A', 'a resposta destrava o A'))
    expect(await s.service.reply('conv-a', 'A chave é XYZ')).toEqual({ stored: true })
    await vi.waitFor(() => expect(s.last().folders[0].resposta).toMatchObject({ estado: 'retomar_a', por: 'po', motivo: 'a resposta destrava o A' }))
    expect(s.evaluate.mock.calls[0][0]).toMatchObject({ kind: 'resposta', reply: 'A chave é XYZ', a: { plan: { loteId: 'la' } }, b: { plan: { loteId: 'lb' } } })
    // O A tem a vez, mas o B ainda roda: A e B nunca rodam juntos.
    expect(s.last().folders[0].plans.map((p) => p.planTitulo)).toEqual(['Plano A', 'Plano B'])
    expect(motivo(await s.next('conv-a'))).toBe('esperando o prompt atual do plano "Plano B" terminar')

    // O prompt atual do B termina: o A é solto (a resposta sai) e o B espera o A acabar.
    await s.turn('conv-b', [['[b1] Etapa b1', 'completed']])
    expect(s.last().folders[0].resposta).toBeNull()
    expect(motivo(await s.next('conv-b'))).toBe('na fila do projeto (2º): esperando o plano "Plano A" terminar')
  })

  it('ESPERAR_B: o A espera o B inteiro; PERGUNTAR: os botões decidem; falha → RETOMAR_A', async () => {
    const s = await setup()
    await bRunning(s)
    s.evaluate.mockResolvedValueOnce(verdict('ESPERAR_B', 'o B termina logo'))
    await s.service.reply('conv-a', 'oi')
    await vi.waitFor(() => expect(s.last().folders[0].resposta?.estado).toBe('esperar_b'))
    expect(s.last().folders[0].plans[0].planTitulo).toBe('Plano B')
    // Uma segunda mensagem no A espera junto, sem outra decisão.
    expect(await s.service.reply('conv-a', 'e mais isto')).toEqual({ stored: true })
    expect(s.evaluate).toHaveBeenCalledTimes(1)

    const s2 = await setup()
    await bRunning(s2)
    s2.evaluate.mockResolvedValueOnce(verdict('PERGUNTAR', 'volto ao A agora?'))
    await s2.service.reply('conv-a', 'oi')
    await vi.waitFor(() => expect(s2.last().folders[0].resposta).toMatchObject({ estado: 'pergunta', pergunta: 'volto ao A agora?' }))
    await s2.service.action('conv-a', 'retomar_a')
    expect(s2.last().folders[0].resposta).toMatchObject({ estado: 'retomar_a', por: 'usuario' })
    expect(s2.last().folders[0].plans[0].planTitulo).toBe('Plano A')

    const s3 = await setup()
    await bRunning(s3)
    s3.evaluate.mockRejectedValueOnce(new Error('SDK caiu'))
    await s3.service.reply('conv-a', 'oi')
    await vi.waitFor(() => expect(s3.last().folders[0].resposta?.estado).toBe('retomar_a'))
    expect(s3.last().folders[0].avaliacao).toMatchObject({ kind: 'resposta', decisao: 'RETOMAR_A', falhou: true })
  })

  it('"Enviar agora mesmo assim" vence a decisão do PO; conversa livre não guarda nada', async () => {
    const s = await setup()
    await bRunning(s)
    let release!: (o: ProjectEvaluationOutcome) => void
    s.evaluate.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    await s.service.reply('conv-a', 'oi')
    await vi.waitFor(() => expect(s.last().folders[0].avaliando).toBe('resposta'))
    await s.service.action('conv-a', 'enviar_agora')
    release(verdict('ESPERAR_B'))
    await vi.waitFor(() => expect(s.last().folders[0].avaliando).toBeNull())
    expect(s.last().folders[0].resposta).toMatchObject({ estado: 'agora' })
    expect(await s.service.reply('conv-a', 'mais uma')).toEqual({ stored: false })
    // Com a vez agora do A, o B (que estava rodando) espera: a mensagem dele também fica guardada.
    expect(await s.service.reply('conv-b', 'ajuste')).toEqual({ stored: true })
  })
})
