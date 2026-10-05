import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HandoffEnvio } from '../../shared/handoffTracking'
import type { BoardItem, ChatEvent, TaskItem } from '../../shared/ipc'
import { BoardService } from '../board/boardService'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { HandoffTracker, type HandoffTrackerDeps } from './handoffTracker'

/**
 * O tracker de verdade sobre um SqliteRepository de verdade (pasta temporária)
 * e o BoardService de verdade, com o relógio do tracker na mão do teste. Os
 * eventos entram na MESMA ordem do index.ts: primeiro o tracker, depois o quadro.
 * Só teste importa daqui.
 */

export const CONV = 'conv-impl'

export interface PromptSpec {
  conteudo: string
  etapas: string[]
  /** A estimativa do plano (prazo) de cada etapa, na ordem; padrão 30 min. */
  estimativas?: Array<number | null>
}

export interface Harness {
  repo: SqliteRepository
  board: BoardService
  tracker: HandoffTracker
  cwd: string
  projectId: string
  /** Avisos handoff:changed, em ordem. */
  changed: string[]
  logs: string[]
  po: { enabled: boolean }
  now(): number
  advance(ms: number): void
  register(prompts: PromptSpec[], conv?: string): Promise<HandoffEnvio[]>
  emit(event: ChatEvent, conv?: string): void
  /** Snapshot `task-list` do agente: [título, status] na ordem. */
  tasks(items: Array<[string, TaskItem['status']]>, conv?: string): void
  cards(conv?: string): Promise<BoardItem[]>
  cardOf(prefix: string, conv?: string): Promise<BoardItem>
  settle(): Promise<void>
  /** Os envios da conversa, por ordem. */
  envios(conv?: string): Promise<HandoffEnvio[]>
  /** Outro tracker sobre o mesmo banco (o app reaberto). */
  reopen(deps?: Partial<HandoffTrackerDeps>): HandoffTracker
}

const opened: Array<{ repo: SqliteRepository; dir: string }> = []

export async function harness(options: { attach?: boolean; deps?: Partial<HandoffTrackerDeps> } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-code-tracker-'))
  const repo = new SqliteRepository(dir, join(dir, 'agent-code.db'), 'device-a')
  await repo.initialize()
  opened.push({ repo, dir })
  const cwd = join(dir, 'projeto')
  await mkdir(cwd)

  // Um dia à frente do relógio real: o `updatedAt` que o banco carimba com o
  // relógio de verdade fica sempre "antigo" para o tracker, e os limites de
  // tempo do teste (a parada) ficam exatos.
  let clock = Date.now() + 24 * 60 * 60_000
  const changed: string[] = []
  const logs: string[] = []
  const po = { enabled: true }
  let tracker!: HandoffTracker
  const board = new BoardService({ repository: () => repo, onChanged: (projectId) => tracker.boardChanged(projectId) })
  const make = (extra: Partial<HandoffTrackerDeps> = {}): HandoffTracker =>
    new HandoffTracker({
      repository: () => repo,
      board,
      poEnabled: () => po.enabled,
      clock: () => clock,
      onChanged: (conv) => changed.push(conv),
      log: (line) => logs.push(line),
      ...options.deps,
      ...extra
    })
  tracker = make()
  const projectId = await board.projectId(cwd)
  if (options.attach !== false) tracker.attach(CONV, cwd)

  const h: Harness = {
    repo,
    board,
    get tracker() {
      return tracker
    },
    cwd,
    projectId,
    changed,
    logs,
    po,
    now: () => clock,
    advance: (ms) => {
      clock += ms
    },
    async register(prompts, conv = CONV) {
      const envios = await repo.createHandoffEnvios(
        prompts.map((prompt, index) => ({
          planSlug: 'plano',
          planTitulo: 'Plano',
          projectId,
          projectCwd: cwd,
          conversationId: conv,
          conversationTitle: 'Implementação',
          arquivo: `2026-10-05-0${index + 1}.md`,
          ordem: index + 1,
          loteId: 'hl-1',
          conteudo: prompt.conteudo,
          entregas: prompt.etapas.map((etapaId, i) => ({
            etapaId,
            etapaTitulo: `Etapa ${etapaId}`,
            estimativaPlano: prompt.estimativas?.[i] === undefined ? 30 : prompt.estimativas[i]
          }))
        }))
      )
      tracker.onRegistered(envios)
      return envios
    },
    emit(event, conv = CONV) {
      tracker.observe(conv, cwd, event)
      board.observe(conv, cwd, event)
    },
    tasks(items, conv = CONV) {
      h.emit(
        {
          kind: 'task-list',
          items: items.map(([content, status], index) => ({ id: String(index + 1), content, status, activeForm: content }))
        },
        conv
      )
    },
    async cards(conv = CONV) {
      return (await board.list(cwd, { conversationId: conv })) ?? []
    },
    async cardOf(prefix, conv = CONV) {
      const found = (await h.cards(conv)).find((card) => card.sourceTitle.startsWith(prefix))
      if (!found) throw new Error(`cartão ${prefix} não encontrado`)
      return found
    },
    async settle() {
      for (let i = 0; i < 4; i++) {
        await board.settled(CONV)
        await board.turnClosed(CONV)
        await tracker.settled()
      }
    },
    async envios(conv = CONV) {
      return (await repo.listHandoffEnvios({ conversationId: conv })).sort((a, b) => a.ordem - b.ordem)
    },
    reopen(deps = {}) {
      tracker = make(deps)
      return tracker
    }
  }
  return h
}

/** Fecha os bancos e apaga as pastas — chame no afterEach. */
export async function closeHarnesses(): Promise<void> {
  const all = opened.splice(0)
  await Promise.all(all.map(({ repo }) => repo.close().catch(() => undefined)))
  await Promise.all(all.map(({ dir }) => rm(dir, { recursive: true, force: true })))
}
