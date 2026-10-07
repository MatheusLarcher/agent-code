// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardConfig, BoardItem, ChatEvent } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { Po, type PoObserverRequest } from './po'
import {
  collectPoGitEvidence,
  formatPoGitEvidence,
  PO_GIT_LABEL,
  PO_GIT_MAX_LINES,
  PO_GIT_SECTION_MAX_CHARS,
  poGitSince
} from './poGit'

const dirs: string[] = []
afterEach(async () => {
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

async function repo(): Promise<string> {
  const dir = await tempDir('agent-code-po-git-')
  git(dir, ['init', '-q'])
  await writeFile(join(dir, 'a.txt'), 'linha 1\n')
  git(dir, ['add', 'a.txt'])
  const old = '2020-01-01T00:00:00Z'
  git(dir, ['commit', '-q', '-m', 'commit antigo'], { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old })
  return dir
}

describe('collectPoGitEvidence — repositório temporário', () => {
  it('status, diff --stat e os commits desde o cartão (os anteriores ficam de fora)', async () => {
    const dir = await repo()
    await writeFile(join(dir, 'b.txt'), 'novo\n')
    git(dir, ['add', 'b.txt'])
    git(dir, ['commit', '-q', '-m', 'feat: fase 1 do escritório'])
    await writeFile(join(dir, 'a.txt'), 'linha 1\nSEGREDO-DO-CONTEUDO\n')
    await writeFile(join(dir, 'c.txt'), 'não rastreado\n')

    const evidence = await collectPoGitEvidence(dir, Date.parse('2024-01-01T00:00:00Z'))
    expect(evidence).not.toBeNull()
    expect(evidence!.status).toEqual([' M a.txt', '?? c.txt'])
    expect(evidence!.diffStat.join('\n')).toMatch(/a\.txt \| 1 \+/)
    expect(evidence!.log).toHaveLength(1)
    expect(evidence!.log[0]).toMatch(/^[0-9a-f]+ feat: fase 1 do escritório$/)

    const section = formatPoGitEvidence(evidence!)
    expect(section.startsWith(PO_GIT_LABEL)).toBe(true)
    // Nunca conteúdo de arquivo: só caminhos, contagens e títulos.
    expect(section).not.toContain('SEGREDO-DO-CONTEUDO')
  })

  it('árvore limpa e sem commit novo: os blocos dizem isso com todas as letras', async () => {
    const dir = await repo()
    const section = formatPoGitEvidence((await collectPoGitEvidence(dir, Date.now() - 60_000))!)
    expect(section).toContain('git status --porcelain: (limpo: nada sem commit)')
    expect(section).toContain('git diff --stat: (sem mudanças)')
    expect(section).toContain('commits desde o cartão: (nenhum)')
  })

  it('pasta que não é repositório, ou pasta vazia no caminho: sem seção e sem erro', async () => {
    const plain = await tempDir('agent-code-po-nogit-')
    expect(await collectPoGitEvidence(plain, null)).toBeNull()
    expect(await collectPoGitEvidence('', null)).toBeNull()
    expect(await collectPoGitEvidence(join(plain, 'nao-existe'), null)).toBeNull()
  })

  it('git que falha no meio também some sem derrubar nada', async () => {
    const run = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === 'rev-parse') return 'true\n'
      throw new Error('git travou')
    })
    expect(await collectPoGitEvidence('C:/qualquer', null, run)).toBeNull()
  })

  it('saída grande é cortada com "(+N linhas)"', async () => {
    const dir = await repo()
    for (let i = 0; i < PO_GIT_MAX_LINES + 12; i++) await writeFile(join(dir, `novo-${String(i).padStart(2, '0')}.txt`), 'x\n')
    const section = formatPoGitEvidence((await collectPoGitEvidence(dir, null))!)
    expect(section).toContain('  (+12 linhas)')
    expect(section.split('\n').filter((line) => line.startsWith('  ?? novo-'))).toHaveLength(PO_GIT_MAX_LINES)
  })

  it('o pior caso da seção cabe no teto documentado', () => {
    const huge = Array.from({ length: 5_000 }, (_, i) => `${i} ${'x'.repeat(600)}`)
    const section = formatPoGitEvidence({ status: huge, diffStat: huge, log: huge })
    expect(section.length).toBeLessThanOrEqual(PO_GIT_SECTION_MAX_CHARS)
  })
})

describe('poGitSince — desde a criação do cartão', () => {
  const at = (iso: string, over: Partial<BoardItem> = {}) => ({ createdAt: iso, dismissedAt: null, poStatus: null, sourceStatus: 'in_progress', ...over }) as BoardItem

  it('o mais antigo dos julgados; sem eles, o mais antigo dos não concluídos', () => {
    const a = at('2026-10-06T10:00:00Z')
    const b = at('2026-10-06T08:00:00Z', { sourceStatus: 'completed' })
    const c = at('2026-10-06T09:00:00Z', { sourceStatus: 'pending' })
    expect(poGitSince([a, b, c], [a])).toBe(Date.parse('2026-10-06T10:00:00Z'))
    expect(poGitSince([a, b, c], [])).toBe(Date.parse('2026-10-06T09:00:00Z'))
    expect(poGitSince([b], [])).toBeNull()
  })
})

describe('Po — a seção do git no prompt', () => {
  const CONV = 'conv-git'
  const config = (): BoardConfig => ({ requirePlan: true, po: { enabled: true, model: 'claude-sonnet-5-5' } })
  const card: BoardItem = {
    id: 'bi-1', projectId: 'p', projectCwd: 'C:/p', conversationId: CONV, origin: 'agent', sourceId: '1',
    sourceTitle: 'Commitar a fase 1', sourceStatus: 'in_progress', activeForm: null, seq: 0, poTitle: null, poNote: null,
    poStatus: null, poReason: null, poAt: null, dismissedAt: null, revision: 1, createdAt: '2026-10-06T10:00:00Z', updatedAt: ''
  }
  const board = {
    settled: vi.fn(async () => undefined),
    list: vi.fn(async () => [card]),
    projectId: vi.fn(async () => 'p'),
    applyPo: vi.fn(async () => card),
    createPoItem: vi.fn(async () => null)
  } as unknown as BoardService
  const result: ChatEvent = { kind: 'result', id: 'r', isError: false, text: 'Commit feito.', durationMs: 1 }

  async function closeRound(gitEvidence?: (cwd: string, since: number | null) => Promise<ReturnType<typeof collectPoGitEvidence> extends Promise<infer T> ? T : never>) {
    const prompts: PoObserverRequest[] = []
    const po = new Po({
      config,
      board,
      gateActive: async () => false,
      listConvTasks: async () => [],
      runClaude: async (request) => {
        prompts.push(request)
        return { provider: 'claude', state: 'completed', text: 'OK' }
      },
      ...(gitEvidence ? { gitEvidence } : {})
    })
    po.noteUserMessage(CONV, 'C:/p', 'commita')
    await po.settled(CONV)
    po.observe(CONV, result)
    await po.settled(CONV)
    return prompts.find((p) => p.phase === 'close')!
  }

  it('com o coletor: a seção entra, com o corte desde a criação do cartão julgado', async () => {
    const since: (number | null)[] = []
    const prompt = await closeRound(async (_cwd, s) => {
      since.push(s)
      return { status: [], diffStat: [], log: ['abc1234 feat: fase 1'] }
    })
    expect(prompt.prompt).toContain(`${PO_GIT_LABEL}\ngit status --porcelain: (limpo: nada sem commit)`)
    expect(prompt.prompt).toContain('commits desde o cartão:\n  abc1234 feat: fase 1')
    expect(since.at(-1)).toBe(Date.parse('2026-10-06T10:00:00Z'))
  })

  it('coletor que falha ou devolve null: o prompt sai sem a seção e a rodada acontece', async () => {
    expect((await closeRound(async () => null)).prompt).not.toContain(PO_GIT_LABEL)
    expect((await closeRound(async () => Promise.reject(new Error('git fora')))).prompt).not.toContain(PO_GIT_LABEL)
    expect((await closeRound()).prompt).not.toContain(PO_GIT_LABEL)
  })
})
