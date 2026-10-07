import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { boardItemStatus, type BoardItem } from '../../shared/ipc'

const execFileAsync = promisify(execFile)

/**
 * A evidência do GIT da pasta para o PO: `git status --porcelain`, `git diff
 * --stat` e os títulos dos commits desde a criação do cartão. É o "avaliar o
 * projeto de verdade" que o usuário escolheu — barato e determinístico, sem
 * rodar teste nem typecheck — e o mesmo sinal que o vigia do git usa.
 *
 * Nunca entra conteúdo de arquivo: só caminhos, contagens de linha e títulos
 * de commit. Pasta que não é repositório, ou git que falha, devolve `null`: a
 * seção some do prompt e a rodada segue como antes.
 */

export interface PoGitEvidence {
  status: string[]
  diffStat: string[]
  /** `<hash> <título>` dos commits desde o cartão (vazio sem data de corte). */
  log: string[]
}

/** Linhas por bloco e caracteres por linha: o prompt do PO não pode crescer com o repositório. */
export const PO_GIT_MAX_LINES = 30
export const PO_GIT_LINE_CHARS = 110
const GIT_TIMEOUT_MS = 5_000
/** Teto do `git log` lido (o bloco mostra só PO_GIT_MAX_LINES; o resto vira "+N"). */
const GIT_LOG_MAX = 500

export const PO_GIT_LABEL = 'GIT DA PASTA (evidência; nunca conteúdo de arquivo):'
const TITLE_STATUS = 'git status --porcelain:'
const TITLE_DIFF = 'git diff --stat:'
const TITLE_LOG = 'commits desde o cartão:'
const EMPTY_STATUS = '(limpo: nada sem commit)'
const EMPTY_DIFF = '(sem mudanças)'
const EMPTY_LOG = '(nenhum)'
const INDENT = '  '
/** A linha "(+N linhas)" no pior caso (N de até 7 dígitos). */
const OVERFLOW_MAX_CHARS = INDENT.length + '(+9999999 linhas)'.length

/**
 * O pior caso da seção, em caracteres: rótulo, os três títulos, as linhas
 * cheias e o "+N" de cada bloco, com as quebras de linha. O teste monta a seção
 * com tudo estourado e exige que ela caiba aqui.
 */
export const PO_GIT_SECTION_MAX_CHARS =
  PO_GIT_LABEL.length +
  [TITLE_STATUS, TITLE_DIFF, TITLE_LOG].join('').length +
  3 * (PO_GIT_MAX_LINES * (INDENT.length + PO_GIT_LINE_CHARS) + OVERFLOW_MAX_CHARS) +
  // quebras: rótulo + 3 × (título + linhas + "+N")
  3 * (1 + PO_GIT_MAX_LINES + 1)

export type GitRunner = (cwd: string, args: string[]) => Promise<string>

/** `--no-optional-locks`: o `status` de fundo não disputa o lock do índice com o agente. */
export const runGit: GitRunner = async (cwd, args) => {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '--no-optional-locks', ...args], {
    windowsHide: true,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024
  })
  return stdout
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
}

export async function collectPoGitEvidence(
  cwd: string,
  sinceMs: number | null,
  run: GitRunner = runGit
): Promise<PoGitEvidence | null> {
  if (!cwd) return null
  try {
    if ((await run(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') return null
    const [status, diffStat, log] = await Promise.all([
      run(cwd, ['status', '--porcelain']),
      // Repositório sem commit nenhum: não há HEAD para comparar.
      run(cwd, ['diff', 'HEAD', '--stat']).catch(() => run(cwd, ['diff', '--stat'])),
      sinceMs === null || !Number.isFinite(sinceMs)
        ? Promise.resolve('')
        : run(cwd, ['log', `--since=${new Date(sinceMs).toISOString()}`, '--format=%h %s', '-n', String(GIT_LOG_MAX)]).catch(() => '')
    ])
    return { status: nonEmptyLines(status), diffStat: nonEmptyLines(diffStat), log: nonEmptyLines(log) }
  } catch {
    return null
  }
}

/** Corta sem colapsar espaços: as duas colunas do `--porcelain` e o alinhamento
 *  do `--stat` são parte do que a linha diz. */
function cut(line: string): string {
  return line.length > PO_GIT_LINE_CHARS ? `${line.slice(0, PO_GIT_LINE_CHARS - 1)}…` : line
}

function block(title: string, items: readonly string[], empty: string): string[] {
  if (items.length === 0) return [`${title} ${empty}`]
  const shown = items.slice(0, PO_GIT_MAX_LINES).map((line) => `${INDENT}${cut(line)}`)
  const extra = items.length - PO_GIT_MAX_LINES
  return [title, ...shown, ...(extra > 0 ? [`${INDENT}(+${extra} linhas)`] : [])]
}

export function formatPoGitEvidence(evidence: PoGitEvidence): string {
  return [
    PO_GIT_LABEL,
    ...block(TITLE_STATUS, evidence.status, EMPTY_STATUS),
    ...block(TITLE_DIFF, evidence.diffStat, EMPTY_DIFF),
    ...block(TITLE_LOG, evidence.log, EMPTY_LOG)
  ].join('\n')
}

/**
 * Desde quando contar os commits: a criação do cartão mais antigo em jogo — os
 * que este fechamento julga ou, sem eles, os que ainda não terminaram. Sem
 * cartão em jogo não há "desde o cartão": o bloco de commits sai vazio.
 */
export function poGitSince(cards: readonly BoardItem[], returned: readonly BoardItem[]): number | null {
  const open = returned.length > 0 ? returned : cards.filter((card) => card.dismissedAt === null && boardItemStatus(card) !== 'completed')
  const times = open.map((card) => Date.parse(card.createdAt)).filter((ms) => Number.isFinite(ms))
  return times.length > 0 ? Math.min(...times) : null
}
