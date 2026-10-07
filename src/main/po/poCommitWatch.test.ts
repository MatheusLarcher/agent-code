// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boardItemStatus, type BoardItem } from '../../shared/ipc'
import { BoardService } from '../board/boardService'
import { SqliteRepository } from '../persistence/sqliteRepository'
import { commitVerdictOps, runPoCommitRound } from './poCommitRound'
import { PoCommitWatch } from './poCommitWatch'
import { collectPoGitEvidence } from './poGit'
import type { PoObserverRequest } from './poProviders'

const dirs: string[] = []
const repos: SqliteRepository[] = []
afterEach(async () => {
  await Promise.all(repos.splice(0).map((repo) => repo.close()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** git num repositório de TESTE: identidade e assinatura locais, nada do usuário. */
function git(dir: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=Teste', '-c', 'user.email=teste@exemplo.invalid', '-c', 'commit.gpgsign=false', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

/** Commit com data no futuro: fica depois da criação do cartão sem depender do relógio. */
async function commit(dir: string, file: string, message: string): Promise<void> {
  await writeFile(join(dir, file), `${message}\n`)
  git(dir, ['add', file])
  const later = new Date(Date.now() + 60_000).toISOString()
  git(dir, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: later, GIT_COMMITTER_DATE: later })
}

async function world(answer: (request: PoObserverRequest) => string | null) {
  const project = await tempDir('agent-code-watch-repo-')
  git(project, ['init', '-q'])
  const old = '2020-01-01T00:00:00Z'
  await writeFile(join(project, 'README.md'), 'projeto\n')
  git(project, ['add', 'README.md'])
  git(project, ['commit', '-q', '-m', 'início'], { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old })

  const data = await tempDir('agent-code-watch-db-')
  const repository = new SqliteRepository(data, join(data, 'agent-code.db'), 'device-a')
  await repository.initialize()
  repos.push(repository)
  const board = new BoardService({ repository: () => repository })
  const projectId = await board.projectId(project)
  const base = { projectId, projectCwd: project, conversationId: 'conv-1' }
  const parent = await repository.createBoardPoItem({ ...base, title: 'Implementar a fase 1 do escritório', status: 'completed', reason: 'entregue' })
  const pendency = await repository.createBoardPoItem({
    ...base,
    title: 'Commitar a fase 1 do escritório',
    status: 'pending',
    reason: 'aguardando autorização do usuário',
    parentId: parent.id
  })

  const requests: PoObserverRequest[] = []
  const head = vi.fn(async (cwd: string) => git(cwd, ['rev-parse', 'HEAD']).trim())
  const watch = new PoCommitWatch({
    enabled: () => true,
    board,
    head,
    evidence: (cwd, since) => collectPoGitEvidence(cwd, since),
    judge: (input) =>
      runPoCommitRound(
        {
          board,
          model: () => 'claude-sonnet-5-5',
          consult: async (request) => {
            requests.push(request)
            return answer(request)
          }
        },
        input
      )
  })
  const card = async (id: string): Promise<BoardItem> => (await repository.getBoardItem(id)) as BoardItem
  return { project, repository, board, watch, parent, pendency, requests, head, card, base }
}

describe('vigia do git — commit fora do chat conclui a pendência', () => {
  it('commit novo com pendência aberta → rodada só de CONCLUIR, com os commits novos no prompt', async () => {
    const w = await world((request) =>
      request.prompt.includes('feat: fase 1 do escritório') ? `CONCLUIR ${w.pendency.id} | commit "feat: fase 1 do escritório"` : 'OK'
    )
    w.watch.arm(w.project)
    await w.watch.check()
    // Primeira olhada: nada commitado desde a pendência, então nenhuma rodada.
    expect(w.requests).toHaveLength(0)
    expect(w.watch.watching()).toEqual([w.project])

    await w.watch.check()
    expect(w.requests).toHaveLength(0) // HEAD igual: nada a fazer

    await commit(w.project, 'fase1.ts', 'feat: fase 1 do escritório')
    await w.watch.check()
    expect(w.requests).toHaveLength(1)
    expect(w.requests[0].prompt).toContain('PENDÊNCIAS ABERTAS:')
    expect(w.requests[0].prompt).toContain(`${w.pendency.id} [a fazer] Commitar a fase 1 do escritório (pendência de: Implementar a fase 1 do escritório)`)
    expect(w.requests[0].prompt).toMatch(/commits desde o cartão:\n {2}[0-9a-f]+ feat: fase 1 do escritório/)
    expect(await w.card(w.pendency.id)).toMatchObject({ poStatus: 'completed', poReason: 'commit "feat: fase 1 do escritório"' })

    // Sem pendência aberta, a checagem daquela pasta para.
    await w.watch.check()
    expect(w.watch.watching()).toEqual([])
  })

  it('sem pendência aberta no projeto → nenhuma checagem de HEAD e a pasta sai da vigia', async () => {
    const w = await world(() => 'OK')
    await w.repository.applyBoardPo({ id: w.pendency.id, poStatus: 'completed', poReason: 'feito no chat' })
    w.watch.arm(w.project)
    await w.watch.check()
    expect(w.head).not.toHaveBeenCalled()
    expect(w.watch.watching()).toEqual([])
    expect(w.requests).toHaveLength(0)
  })

  it('veredito com qualquer coisa além de CONCLUIR em pendência: descartado pelo código', async () => {
    const w = await world(() =>
      [
        `NOVA | Fazer o deploy da fase 1 | o agente disse`,
        `TITULO ${w.pendency.id} | Outro título | legível`,
        `PENDENTE ${w.pendency.id} | falta push`,
        `CONCLUIR ${w.parent.id} | não é pendência`,
        'FEITA | Commit feito | feito'
      ].join('\n')
    )
    w.watch.arm(w.project)
    await w.watch.check()
    await commit(w.project, 'x.ts', 'chore: outra coisa')
    await w.watch.check()

    expect(w.requests).toHaveLength(1)
    const all = await w.repository.listBoardItems({ projectIds: [w.base.projectId] })
    expect(all).toHaveLength(2)
    expect(await w.card(w.pendency.id)).toMatchObject({ poTitle: null, poStatus: null, sourceStatus: 'pending' })
    expect(boardItemStatus(await w.card(w.parent.id))).toBe('completed')
    expect((await w.card(w.parent.id)).poReason).toBe('entregue')
  })

  it('abertura do app: commit feito com o app fechado (depois da pendência) é julgado na primeira olhada', async () => {
    const w = await world((request) => (request.prompt.includes('fix: commit manual') ? `CONCLUIR ${w.pendency.id} | commit manual` : 'OK'))
    await commit(w.project, 'm.ts', 'fix: commit manual')
    const boot = new PoCommitWatch({
      enabled: () => true,
      board: w.board,
      head: w.head,
      evidence: (cwd, since) => collectPoGitEvidence(cwd, since),
      judge: (input) =>
        runPoCommitRound({ board: w.board, model: () => 'm', consult: async (request) => (request.prompt.includes('fix: commit manual') ? `CONCLUIR ${w.pendency.id} | commit manual` : 'OK') }, input),
      bootFolders: async () => [w.project]
    })
    await boot.check()
    expect(boardItemStatus(await w.card(w.pendency.id))).toBe('completed')
  })

  it('PO desligado: o vigia não olha nada; o relógio injetado dispara a checagem', async () => {
    const w = await world(() => 'OK')
    let enabled = false
    let tick: (() => void) | null = null
    const watch = new PoCommitWatch({
      enabled: () => enabled,
      board: w.board,
      head: w.head,
      evidence: async () => null,
      judge: async () => [],
      every: (ms, fn) => {
        expect(ms).toBe(15_000)
        tick = fn
        return () => {
          tick = null
        }
      }
    })
    watch.arm(w.project)
    watch.start()
    tick!()
    await watch.check()
    expect(w.head).not.toHaveBeenCalled()
    enabled = true
    tick!()
    await watch.check()
    expect(w.head).toHaveBeenCalled()
    watch.stop()
    expect(tick).toBeNull()
  })

  it('a leitura do veredito do vigia só devolve CONCLUIR em id de pendência', () => {
    const pendencies = [{ id: 'bi-p' }] as BoardItem[]
    expect(commitVerdictOps('CONCLUIR bi-p | ok\nCONCLUIR bi-x | não\nNOVA | a | b\nOK', pendencies)).toEqual([{ id: 'bi-p', reason: 'ok' }])
  })
})
