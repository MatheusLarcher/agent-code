import { decideRoute, type AskFn } from '../centralDecider'
import type { CentralIndex } from '../centralIndex'
import { NO_PROJECT, Q_CONVERSA, Q_PROJETO, type CentralPromptLang } from '../centralPrompts'
import { maskSecrets } from '../centralRedact'
import type { History, HistoryRequest } from './history'
import type { MemoAskStats } from './memoAsk'
import { projectOf, type Gold, type Replay } from './replay'

/**
 * Calibração da Central, parte 4: a fase A. Nas mensagens que NÃO abrem
 * conversa, das conversas de projeto, faz só a 1ª chamada do decisor e separa
 * as que ele manda para `sem_projeto`: candidatas a mensagem aleatória no meio
 * de uma tarefa, que o usuário confirma antes de qualquer medição (fase B).
 */

/** Teto de mensagens escaneadas na fase A. */
export const PHASE_A_BUDGET = 1500
export const SNIPPET_MAX_CHARS = 160

export type ScanStatus = 'ok' | 'failed' | 'no-question'

export interface Scanned {
  request: HistoryRequest
  project: string
  title: string
  gold: Gold
  status: ScanStatus
  /** A chave escolhida na pergunta `projeto` (pN ou `sem_projeto`). */
  choice?: string
  /** A chave do projeto da própria conversa na pergunta (ausente se ele não coube). */
  ownOption?: string
  pNoProject?: number
  /** Probabilidade do projeto da própria conversa (ausente se ele não coube na pergunta). */
  pOwnProject?: number
}

export interface PhaseAOptions {
  lang: CentralPromptLang
  /** Mensagens em paralelo. */
  concurrency: number
  exists(path: string): boolean
  isSandbox(cwd: string): boolean
  onProgress?(done: number, total: number): void
}

export interface CandidatesHeader {
  exportName: string
  lang: CentralPromptLang
  budget: number
  scanned: number
  status: Record<ScanStatus, number>
  calls: MemoAskStats
  generatedAt: Date
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** As mensagens que não abrem conversa, das conversas de projeto, da mais recente para a mais antiga, até o orçamento. */
export function phaseASelection(history: History, budget = PHASE_A_BUDGET): HistoryRequest[] {
  const projects = new Set(history.conversations.filter((conv) => !conv.sandbox).map((conv) => conv.id))
  return history.requests
    .filter((request) => !request.first && projects.has(request.convId))
    .sort((a, b) => b.t - a.t)
    .slice(0, Math.max(0, Math.floor(budget)))
}

/** A resposta de uma pergunta `choice`: a chave e as probabilidades (só números, entre 0 e 1). */
function choiceOf(
  answers: Readonly<Record<string, unknown>> | null | undefined,
  name: string
): { choice: string; probabilities: Record<string, number> } | null {
  const answer = answers?.[name]
  if (!isRecord(answer) || answer.type !== 'choice' || typeof answer.choice !== 'string') return null
  if (!isRecord(answer.probabilities)) return null
  const probabilities: Record<string, number> = {}
  for (const [key, p] of Object.entries(answer.probabilities)) {
    if (typeof p === 'number' && Number.isFinite(p)) probabilities[key] = Math.min(1, Math.max(0, p))
  }
  return { choice: answer.choice, probabilities }
}

/** A chave do projeto da conversa na 1ª chamada: a mesma numeração do decisor (projetos fora do sandbox, p1…). */
function ownProjectOption(index: CentralIndex, cwd: string): string | null {
  const i = index.projects.filter((project) => !project.sandbox).findIndex((project) => project.cwd === cwd)
  return i >= 0 ? `p${i + 1}` : null
}

/**
 * Faz a 1ª chamada do decisor para cada mensagem, pelo próprio `decideRoute`
 * (o pedido é idêntico ao da medição, e a memoização o reaproveita lá). A 2ª
 * chamada é recusada sem ir à rede: o decisor cai na heurística, sem custo.
 */
export async function scanFirstCalls(
  selection: readonly HistoryRequest[],
  history: History,
  replay: Replay,
  ask: AskFn,
  options: PhaseAOptions
): Promise<Scanned[]> {
  const convs = new Map(history.conversations.map((conv) => [conv.id, conv]))
  const results = new Array<Scanned>(selection.length)
  let next = 0
  let done = 0

  async function scanOne(request: HistoryRequest): Promise<Scanned> {
    const conv = convs.get(request.convId)
    if (!conv) throw new Error('pedido sem conversa no histórico')
    const moment = replay.at(request)
    const base = { request, project: projectOf(conv), title: conv.title, gold: moment.gold }
    const seen: { offered?: string[]; answers?: Readonly<Record<string, unknown>> | null } = {}
    const firstOnly: AskFn = async (call) => {
      if (Q_CONVERSA in call.questions) return null
      const question = call.questions[Q_PROJETO]
      seen.offered = question && question.type === 'choice' ? Object.keys(question.criteria) : []
      seen.answers = await ask(call)
      return seen.answers
    }
    await decideRoute(moment.request, moment.index, {
      ask: firstOnly,
      lang: options.lang,
      exists: options.exists,
      isSandbox: options.isSandbox
    })
    if (!seen.offered || seen.offered.length === 0) return { ...base, status: 'no-question' }
    const answer = choiceOf(seen.answers, Q_PROJETO)
    if (!answer || !seen.offered.includes(answer.choice)) return { ...base, status: 'failed' }
    const own = ownProjectOption(moment.index, conv.cwd)
    const offeredOwn = own !== null && seen.offered.includes(own)
    return {
      ...base,
      status: 'ok',
      choice: answer.choice,
      pNoProject: answer.probabilities[NO_PROJECT] ?? 0,
      ...(offeredOwn ? { ownOption: own, pOwnProject: answer.probabilities[own] ?? 0 } : {})
    }
  }

  const workers = Math.max(1, Math.min(Math.floor(options.concurrency) || 1, selection.length))
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < selection.length) {
        const i = next++
        results[i] = await scanOne(selection[i])
        options.onProgress?.(++done, selection.length)
      }
    })
  )
  return results
}

/** As candidatas: resposta `sem_projeto`, da maior probabilidade para a menor (empate: a mais recente primeiro). */
export function phaseACandidates(scanned: readonly Scanned[]): Scanned[] {
  return scanned
    .filter((s) => s.status === 'ok' && s.choice === NO_PROJECT)
    .sort((a, b) => (b.pNoProject ?? 0) - (a.pNoProject ?? 0) || b.request.t - a.request.t)
}

/** Um trecho numa linha, com os segredos mascarados ANTES do corte, em até `max` caracteres (reticências inclusas). */
export function snippet(text: string, max = SNIPPET_MAX_CHARS): string {
  const line = maskSecrets(text).replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  let cut = line.slice(0, max - 1)
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1)
  return `${cut.trimEnd()}…`
}

/** A hora local, `AAAA-MM-DD HH:MM`. */
export function localStamp(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const cell = (text: string): string => text.replace(/\|/g, '\\|')

/** O `calibration-candidates.md`: a tabela numerada, ordenada pela probabilidade de `sem_projeto`. */
export function candidatesMarkdown(candidates: readonly Scanned[], header: CandidatesHeader): string {
  const lines = [
    '# Central — candidatas a mensagens aleatórias (calibração, fase A)',
    '',
    `- Exportação lida (só leitura): \`${header.exportName}\` · gerado em ${localStamp(header.generatedAt.getTime())}.`,
    `- Mensagens escaneadas: **${header.scanned}** — as que não abrem conversa, nas conversas de projeto, da mais ` +
      `recente para a mais antiga (orçamento da fase A: ${header.budget}).`,
    `- Pergunta: só a 1ª chamada do decisor (instruções em \`${header.lang}\`); candidata = resposta \`${NO_PROJECT}\` ` +
      `na pergunta \`${Q_PROJETO}\`.`,
    `- Sem resposta válida do TypeSafe: ${header.status.failed} · sem a pergunta \`${Q_PROJETO}\`: ` +
      `${header.status['no-question']} · chamadas ao TypeSafe nesta rodada: ${header.calls.network} ` +
      `(reaproveitadas do cache: ${header.calls.hits}).`,
    `- Candidatas: **${candidates.length}**.`,
    '',
    'Confirme ou edite a lista pelo nº: as confirmadas viram "sandbox" no gabarito da fase B. A probabilidade é a ' +
      `que o TypeSafe deu a \`${NO_PROJECT}\`; trechos com até ${SNIPPET_MAX_CHARS} caracteres, segredos mascarados.`,
    '',
    `| nº | projeto | título da conversa | data | trecho | P(${NO_PROJECT}) |`,
    '|---:|---|---|---|---|---:|',
    ...candidates.map(
      (c, i) =>
        `| ${i + 1} | ${cell(c.project)} | ${cell(snippet(c.title))} | ${localStamp(c.request.t)} | ` +
        `${cell(snippet(c.request.text))} | ${(c.pNoProject ?? 0).toFixed(2)} |`
    )
  ]
  return `${lines.join('\n')}\n`
}
