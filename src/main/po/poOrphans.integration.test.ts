// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HandoffEnvio } from '../../shared/handoffTracking'
import type { BoardConfig, ChatEvent } from '../../shared/ipc'
import { BoardService } from '../board/boardService'
import { HandoffTracker } from '../handoffTracking/handoffTracker'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { Po } from './po'
import { PO_ORPHAN_SECTION } from './poPrompt'

/**
 * Ponta a ponta, com a MESMA ligação do index.ts: SQLite de verdade, o
 * BoardService (que espera o PO antes do fim de turno), o HandoffTracker e o Po
 * com `orphanEtapas` ligado ao tracker. O agente declarou só a etapa `[a]`; a
 * `[b]` foi feita sem cartão, e é o PO que a resolve.
 */

const CONV = 'conv-impl'
const opened: Array<{ repo: SqliteRepository; dir: string }> = []

afterEach(async () => {
  const all = opened.splice(0)
  await Promise.all(all.map(({ repo }) => repo.close().catch(() => undefined)))
  await Promise.all(all.map(({ dir }) => rm(dir, { recursive: true, force: true })))
})

interface Setup {
  repo: SqliteRepository
  board: BoardService
  tracker: HandoffTracker
  po: Po
  cwd: string
  envio(): Promise<HandoffEnvio>
  /** O tee do index.ts: o tracker primeiro; o `turn-start` não passa dele. */
  emit(event: ChatEvent): void
  settle(): Promise<void>
}

async function setup(options: { ask(prompt: string): Promise<string>; poEnabled?: boolean; trackerSeesBoard?: boolean; poWaitMs?: number }): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-code-po-orphans-'))
  const repo = new SqliteRepository(dir, join(dir, 'agent-code.db'), 'device-a')
  await repo.initialize()
  opened.push({ repo, dir })
  const cwd = join(dir, 'projeto')
  await mkdir(cwd)
  const enabled = options.poEnabled ?? true
  const config = (): BoardConfig => ({ requirePlan: true, po: { enabled, model: 'm' } })
  let tracker!: HandoffTracker
  let po!: Po
  const board = new BoardService({
    repository: () => repo,
    // Sem o aviso ao tracker, só o fim de turno pode ver o cartão do PO.
    onChanged: (projectId) => (options.trackerSeesBoard ? tracker.boardChanged(projectId) : undefined),
    poSettled: (convId) => po.settled(convId),
    poWaitMs: options.poWaitMs ?? 5_000,
    poEnabled: () => enabled
  })
  tracker = new HandoffTracker({ repository: () => repo, board, poEnabled: () => enabled })
  po = new Po({
    config,
    board,
    ask: options.ask,
    gateActive: async () => false,
    scheduleFlush: () => () => undefined,
    orphanEtapas: (convId) => tracker.orphanEtapas(convId)
  })
  tracker.attach(CONV, cwd)
  const projectId = await board.projectId(cwd)
  const envios = await repo.createHandoffEnvios([
    {
      planSlug: 'plano',
      planTitulo: 'Plano',
      projectId,
      projectCwd: cwd,
      conversationId: CONV,
      conversationTitle: 'Implementação',
      arquivo: '2026-10-08-01.md',
      ordem: 1,
      loteId: 'hl-1',
      conteudo: 'Prompt 1',
      entregas: ['a', 'b'].map((etapaId) => ({ etapaId, etapaTitulo: `Etapa ${etapaId}`, estimativaPlano: 30 }))
    }
  ])
  tracker.onRegistered(envios)
  const s: Setup = {
    repo,
    board,
    tracker,
    po,
    cwd,
    envio: async () => (await repo.listHandoffEnvios({ conversationId: CONV }))[0],
    emit(event) {
      tracker.observe(CONV, cwd, event)
      if (event.kind === 'turn-start') return
      board.observe(CONV, cwd, event)
      po.observe(CONV, event)
    },
    async settle() {
      for (let i = 0; i < 3; i++) {
        await po.settled(CONV)
        await board.settled(CONV)
        await board.turnClosed(CONV)
        await tracker.settled()
      }
    }
  }
  return s
}

/** O prompt sai, o agente declara só a `[a]` (concluída) e o turno termina. */
async function turn(s: Setup): Promise<void> {
  s.tracker.noteUserSend(CONV, 'Prompt 1')
  s.po.noteUserMessage(CONV, s.cwd, 'Prompt 1')
  s.emit({ kind: 'turn-start', turnIds: ['u1'] })
  s.emit({ kind: 'task-list', items: [{ id: '1', content: '[a] Etapa a', status: 'completed', activeForm: 'Etapa a' }] })
  await s.board.settled(CONV)
  s.emit({ kind: 'result', id: 'r1', isError: false, text: 'Pronto: a tabela (etapa a) e src/b.ts (etapa b) feitos.', durationMs: 1 })
}

const FEITA = 'FEITA | [b] Etapa b | a resposta diz src/b.ts feito'

const answer = (close: string) => async (prompt: string) => (prompt.includes(PO_ORPHAN_SECTION) ? close : 'OK')

describe('PO + acompanhamento: a etapa feita sem cartão', () => {
  it('FEITA `[b]` do PO é visto pelo fim de turno (turnEndOutcome): a entrega e o envio concluem no mesmo turno', async () => {
    const s = await setup({ ask: answer(FEITA) })
    await turn(s)
    await s.settle()

    const envio = await s.envio()
    const cards = (await s.board.list(s.cwd, { conversationId: CONV })) ?? []
    const poCard = cards.find((card) => card.origin === 'po')
    expect(poCard).toMatchObject({ sourceTitle: '[b] Etapa b', sourceStatus: 'completed' })
    expect(envio.status).toBe('concluida')
    expect(envio.entregas.find((e) => e.etapaId === 'b')).toMatchObject({ status: 'concluida', boardItemId: poCard?.id, auditada: true })
    // O casamento acha o cartão do PO: a etapa deixou de ser órfã.
    expect(await s.tracker.orphanEtapas(CONV)).toEqual([])
  })

  it('o FEITA que chega depois do fim de turno é visto pelo reconciliador: o envio incompleto conclui', async () => {
    let release!: () => void
    const late = new Promise<void>((resolve) => (release = resolve))
    const s = await setup({
      trackerSeesBoard: true,
      poWaitMs: 1,
      ask: async (prompt) => (prompt.includes(PO_ORPHAN_SECTION) ? late.then(() => FEITA) : 'OK')
    })
    await turn(s)
    await s.board.turnClosed(CONV)
    await s.tracker.settled()
    const before = await s.envio()
    expect(before.status).toBe('incompleta')
    expect(before.motivo).toContain('sem cartão no Quadro com o prefixo [b]')

    release()
    await s.settle()
    const after = await s.envio()
    expect(after.status).toBe('concluida')
    expect(after.entregas.every((e) => e.status === 'concluida')).toBe(true)
  })

  it('NOVA `[b]` cria o cartão "a fazer" que o casamento acha: a entrega fica incompleta pelo cartão, não pela falta dele', async () => {
    const s = await setup({ ask: answer('NOVA | [b] Etapa b | a resposta não mostra a etapa b') })
    await turn(s)
    await s.settle()

    const envio = await s.envio()
    expect(envio.status).toBe('incompleta')
    expect(envio.motivo).toContain('[b] Etapa b — cartão a fazer')
    expect(envio.entregas.find((e) => e.etapaId === 'b')?.boardItemId).toMatch(/^bi-po-/)
    expect(await s.tracker.orphanEtapas(CONV)).toEqual([])
  })

  it('PO desligado: nenhum cartão automático — a etapa continua sem cartão', async () => {
    const asked: string[] = []
    const s = await setup({ poEnabled: false, ask: async (prompt) => (asked.push(prompt), FEITA) })
    await turn(s)
    await s.settle()

    expect(asked).toEqual([])
    expect(((await s.board.list(s.cwd, { conversationId: CONV })) ?? []).some((card) => card.origin === 'po')).toBe(false)
    expect((await s.envio()).motivo).toContain('sem cartão no Quadro com o prefixo [b]')
  })
})
