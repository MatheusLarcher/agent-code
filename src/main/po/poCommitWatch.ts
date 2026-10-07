import { resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { BoardItem } from '../../shared/ipc'
import type { BoardService } from '../board/boardService'
import { isOpenPendency, type PoCommitRoundInput } from './poCommitRound'
import type { PoGitEvidence } from './poGit'

const execFileAsync = promisify(execFile)

/**
 * O VIGIA DO GIT: percebe o commit feito fora do chat e dispara a rodada do PO
 * que só conclui pendência (poCommitRound.ts).
 *
 * Por checagem, não por evento: `git rev-parse HEAD` a cada 15 s e quando a
 * janela do app ganha foco. O `fs.watch` não é consistente entre plataformas
 * e falha em casos que acontecem no Windows, e o git grava as refs trocando
 * arquivos (`main.lock` → `main`, `packed-refs`) — https://nodejs.org/api/fs.html#caveats.
 * A checagem é uma linha de comando barata e funciona igual em qualquer pasta,
 * inclusive dentro do OneDrive.
 *
 * Só olha a pasta que tem pendência "a fazer": sem pendência aberta, ela sai
 * da vigia (a checagem para) até alguém armá-la de novo — o PO criando uma
 * pendência, o quadro daquela pasta sendo lido, a abertura do app.
 */

export const PO_COMMIT_WATCH_INTERVAL_MS = 15_000
/** Pastas nunca avaliadas por passada: a varredura da abertura não pesa de uma vez. */
const MAX_FRESH_PER_PASS = 4
const HEAD_TIMEOUT_MS = 5_000

export interface PoCommitWatchDeps {
  /** PO ligado? Desligado, o vigia não faz nada (o quadro é só do agente). */
  enabled(): boolean
  board: Pick<BoardService, 'list' | 'projectId'>
  /** `git rev-parse HEAD` da pasta; `null` quando não é repositório ou o git falha. */
  head?(cwd: string): Promise<string | null>
  /** O git da pasta (poGit.ts) com os commits desde `sinceMs`. */
  evidence(cwd: string, sinceMs: number | null): Promise<PoGitEvidence | null>
  /** A rodada que só conclui (poCommitRound.ts); devolve os ids concluídos. */
  judge(input: PoCommitRoundInput): Promise<string[]>
  /** As pastas deste PC com conversa — a varredura da abertura do app. */
  bootFolders?(): Promise<string[]>
  /** O relógio da checagem (o teste injeta o seu). */
  every?(ms: number, fn: () => void): () => void
}

interface Watched {
  cwd: string
  /** O último HEAD visto; `null` antes da primeira olhada. */
  head: string | null
}

/** A chave da pasta: o mesmo caminho escrito de dois jeitos é uma pasta só. */
function folderKey(cwd: string): string {
  const full = resolve(cwd)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

export async function gitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, '--no-optional-locks', 'rev-parse', 'HEAD'], {
      windowsHide: true,
      timeout: HEAD_TIMEOUT_MS
    })
    const head = stdout.trim()
    return /^[0-9a-f]{7,64}$/i.test(head) ? head : null
  } catch {
    return null
  }
}

function oldestCreatedAt(cards: readonly BoardItem[]): number | null {
  const times = cards.map((card) => Date.parse(card.createdAt)).filter((ms) => Number.isFinite(ms))
  return times.length > 0 ? Math.min(...times) : null
}

export class PoCommitWatch {
  private readonly armed = new Map<string, Watched>()
  private pass: Promise<void> | null = null
  private cancel: (() => void) | null = null
  private booted = false

  constructor(private readonly deps: PoCommitWatchDeps) {}

  /** Põe a pasta na vigia (sem efeito se já estiver). A próxima checagem decide se fica. */
  arm(cwd: string): void {
    if (!cwd) return
    const key = folderKey(cwd)
    if (!this.armed.has(key)) this.armed.set(key, { cwd, head: null })
  }

  /** As pastas na vigia agora — para o teste e o diagnóstico. */
  watching(): string[] {
    return [...this.armed.values()].map((entry) => entry.cwd)
  }

  start(): void {
    if (this.cancel) return
    const every =
      this.deps.every ??
      ((ms: number, fn: () => void) => {
        const timer = setInterval(fn, ms)
        timer.unref?.()
        return () => clearInterval(timer)
      })
    this.cancel = every(PO_COMMIT_WATCH_INTERVAL_MS, () => void this.check())
  }

  stop(): void {
    this.cancel?.()
    this.cancel = null
  }

  /** Uma passada (o relógio e o foco da janela chamam). Uma de cada vez; nunca lança. */
  check(): Promise<void> {
    this.pass ??= this.run()
      .catch(() => undefined)
      .finally(() => {
        this.pass = null
      })
    return this.pass
  }

  private async run(): Promise<void> {
    if (!this.deps.enabled()) return
    await this.boot()
    let fresh = 0
    for (const [key, entry] of [...this.armed]) {
      if (entry.head === null && fresh++ >= MAX_FRESH_PER_PASS) continue
      await this.look(key, entry).catch(() => undefined)
    }
  }

  private async boot(): Promise<void> {
    if (this.booted || !this.deps.bootFolders) return
    try {
      for (const cwd of await this.deps.bootFolders()) this.arm(cwd)
      this.booted = true
    } catch {
      // Banco ainda abrindo: a próxima passada tenta de novo.
    }
  }

  private async look(key: string, entry: Watched): Promise<void> {
    const cards = await this.deps.board.list(entry.cwd)
    const open = (cards ?? []).filter(isOpenPendency)
    // Sem quadro, ou sem pendência aberta: a checagem desta pasta para.
    if (open.length === 0) {
      this.armed.delete(key)
      return
    }
    const head = await (this.deps.head ?? gitHead)(entry.cwd)
    if (!head) {
      this.armed.delete(key)
      return
    }
    const firstLook = entry.head === null
    if (!firstLook && head === entry.head) return
    entry.head = head
    const since = oldestCreatedAt(open)
    const evidence = await this.deps.evidence(entry.cwd, since)
    if (!evidence) return
    // Na primeira olhada (abertura do app, pasta recém-armada) só há rodada se
    // já existe commit desde a pendência — o commit feito com o app fechado.
    if (firstLook && evidence.log.length === 0) return
    const projectId = await this.deps.board.projectId(entry.cwd)
    if (!projectId) return
    await this.deps.judge({ cwd: entry.cwd, projectId, git: evidence })
  }
}
