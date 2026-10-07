import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentEnvio, isEnvioSent, type HandoffEnvio } from '../../shared/handoffTracking'
import type { HandoffProjectReplyVerdict, HandoffProjectTurnVerdict } from '../../shared/handoffProject'
import { runPoAgentQuery, type PoAgentRequest, type PoAgentResult } from '../po/poAgentQuery'
import { formatPoGitEvidence, type PoGitEvidence } from '../po/poGit'
import { changedBetween, type ProjectGit } from './projectQueueGit'
import { remainingMinutes, type StoredPlan } from './projectQueueRules'

/**
 * A AVALIAÇÃO DO PO na fila do projeto, nos dois casos em que ele decide a vez:
 * - `vez`: o plano A está parado há 30 min e o B espera → COMECAR | ESPERAR;
 * - `resposta`: o usuário respondeu o A com o B na vez → RETOMAR_A | ESPERAR_B | PERGUNTAR.
 *
 * Roda no modo PO com ferramentas (po/poAgentQuery.ts), com as travas dele. O
 * histórico do A e os prompts vão para arquivos que o PO lê; o git da pasta vai
 * no pedido. A foto do git antes × depois diz o que o PO alterou, e tudo fica
 * num registro. Saída fixa na falha (prazo, teto, formato errado): ESPERAR na
 * `vez` (falha fechada) e RETOMAR_A na `resposta` (o usuário está presente).
 */

export type ProjectEvaluationKind = 'vez' | 'resposta'

export interface ProjectEvaluationInput {
  kind: ProjectEvaluationKind
  cwd: string
  a: { plan: StoredPlan; envios: HandoffEnvio[]; motivo: string; stoppedMinutes?: number }
  b: { plan: StoredPlan; envios: HandoffEnvio[] }
  /** A resposta guardada do usuário (só `resposta`). */
  reply?: string
  signal: AbortSignal
}

export interface ProjectEvaluationOutcome {
  /** Cancelada no meio (o usuário respondeu, passou a vez): não vale nada. */
  cancelled: boolean
  decisao: HandoffProjectTurnVerdict | HandoffProjectReplyVerdict
  motivo: string
  pergunta?: string
  falhou: boolean
  alterados: string[]
  registro: string | null
}

export type ProjectEvaluator = (input: ProjectEvaluationInput) => Promise<ProjectEvaluationOutcome>

export interface ProjectEvaluatorDeps {
  /** Onde ficam os registros (`<userData>/po-avaliacoes`); `null` = pasta temporária. */
  recordsDir: string | null
  git: ProjectGit
  gitEvidence(cwd: string, sinceMs: number | null): Promise<PoGitEvidence | null>
  /** O histórico da conversa em texto (vazio se não der para ler). */
  history(conversationId: string): Promise<string>
  /** O modelo do PO e o env da conta (a conta da conversa do A). */
  runtime(conversationId: string): Promise<{ model: string; env?: NodeJS.ProcessEnv }>
  run?(request: PoAgentRequest): Promise<PoAgentResult>
  now?(): number
}

/** Quantos registros ficam (os mais antigos saem). */
export const PROJECT_RECORDS_KEEP = 20
const MOTIVO_MAX = 500

const TURN_LINE = /^[\s*`>_-]*(COMECAR|COMEÇAR|ESPERAR)[\s*`_]*\|\s*(.+?)[\s*`_]*$/i
const REPLY_LINE = /^[\s*`>_-]*(RETOMAR_A|ESPERAR_B|PERGUNTAR)[\s*`_]*\|\s*(.+?)[\s*`_]*$/i

function lastMatch(text: string, re: RegExp): RegExpExecArray | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = re.exec(lines[i])
    if (match) return match
  }
  return null
}

export function parseTurnVerdict(text: string): { decisao: HandoffProjectTurnVerdict; motivo: string } | null {
  const match = lastMatch(text, TURN_LINE)
  if (!match || !match[2].trim()) return null
  const word = match[1].toUpperCase()
  return { decisao: word === 'ESPERAR' ? 'ESPERAR' : 'COMECAR', motivo: match[2].trim().slice(0, MOTIVO_MAX) }
}

export function parseReplyVerdict(text: string): { decisao: HandoffProjectReplyVerdict; motivo: string } | null {
  const match = lastMatch(text, REPLY_LINE)
  if (!match || !match[2].trim()) return null
  return { decisao: match[1].toUpperCase() as HandoffProjectReplyVerdict, motivo: match[2].trim().slice(0, MOTIVO_MAX) }
}

function why(result: PoAgentResult | null, formatOk: boolean): string {
  if (!result) return 'não rodou'
  if (result.state === 'timeout') return 'passou de 10 min'
  if (result.state === 'max-turns') return 'passou do teto de turnos'
  if (result.state === 'failed') return result.error ? `falhou: ${result.error.slice(0, 160)}` : 'falhou'
  return formatOk ? 'sem resposta' : 'resposta fora do formato'
}

function promptsFile(plan: StoredPlan, envios: readonly HandoffEnvio[]): string {
  const sorted = [...envios].sort((x, y) => x.ordem - y.ordem)
  return [
    `# Prompts do plano "${plan.planTitulo}"`,
    '',
    ...sorted.flatMap((e) => [`## Prompt ${e.ordem} — ${e.arquivo} — ${e.status}${e.motivo ? ` (${e.motivo})` : ''}`, '', e.conteudo, ''])
  ].join('\n')
}

/** "prompt 2 de 3 rodando; faltam ~40 min pela estimativa do plano". */
export function progressLine(envios: readonly HandoffEnvio[]): string {
  const current = currentEnvio(envios)
  const total = envios.length
  const sent = envios.filter(isEnvioSent).length
  const left = remainingMinutes(envios)
  const where = current ? `prompt ${current.ordem} de ${total} (${current.status})` : `nenhum dos ${total} prompts saiu`
  return `${where}; ${sent} de ${total} já saíram${left !== null ? `; faltam ~${left} min pela estimativa do plano` : ''}`
}

function sinceOf(envios: readonly HandoffEnvio[]): number | null {
  const times = envios.map((e) => Date.parse(e.enviadoEm ?? e.criadoEm)).filter((ms) => Number.isFinite(ms))
  return times.length > 0 ? Math.min(...times) : null
}

export function turnPrompt(input: ProjectEvaluationInput, files: { promptsA: string; historyA: string; promptsB: string }, git: string): string {
  const { a, b } = input
  const sortedB = [...b.envios].sort((x, y) => x.ordem - y.ordem)
  return [
    'FILA DO PROJETO — A VEZ DE QUEM?',
    '',
    `Nesta pasta, o plano A ("${a.plan.planTitulo}") está PARADO${a.stoppedMinutes ? ` há ${a.stoppedMinutes} min` : ''} e o plano B ("${b.plan.planTitulo}") espera a vez atrás dele. Nesse tempo o usuário não respondeu na conversa do A nem passou a vez. Decida: começar o B agora ou esperar o usuário voltar ao A.`,
    '',
    '- COMECAR só se o B puder rodar sem misturar com o que o A deixou pela metade: o B não mexe nos mesmos arquivos e não depende do que o A ainda não terminou. Com mudanças do A sem commit na pasta, o app põe a lista desses arquivos no 1º prompt do B, com a ordem de não editá-los nem commitá-los.',
    '- Na dúvida, ESPERAR: o usuário decide quando voltar.',
    '',
    `POR QUE O A PAROU: ${a.motivo}`,
    `OS PROMPTS DO A: ${files.promptsA}`,
    `O HISTÓRICO DA CONVERSA DO A (leia o fim primeiro): ${files.historyA}`,
    `OS PROMPTS COMPLETOS DO B (também em ${files.promptsB}):`,
    ...sortedB.map((e) => `----- prompt ${e.ordem} do B (${e.arquivo}) -----\n${e.conteudo}`),
    '----- fim dos prompts do B -----',
    '',
    git,
    '',
    'Responda com UMA destas linhas, sozinha, no fim:',
    'COMECAR | <o motivo, em uma frase>',
    'ESPERAR | <o motivo, em uma frase>'
  ].join('\n')
}

export function replyPrompt(input: ProjectEvaluationInput, files: { promptsA: string; historyA: string; promptsB: string }, git: string): string {
  const { a, b } = input
  return [
    'FILA DO PROJETO — A RESPOSTA GUARDADA',
    '',
    `O usuário voltou e respondeu na conversa do plano A ("${a.plan.planTitulo}"), mas o plano B ("${b.plan.planTitulo}") está com a vez nesta pasta. A e B nunca rodam juntos: a resposta dele está guardada até você decidir.`,
    '',
    'A RESPOSTA DO USUÁRIO NO A:',
    input.reply ?? '',
    '',
    `O ESTADO DO A: ${a.motivo}. Prompts do A: ${files.promptsA}. Histórico do A (leia o fim primeiro): ${files.historyA}.`,
    `O ANDAMENTO DO B: ${progressLine(b.envios)}. Prompts do B: ${files.promptsB}.`,
    '',
    git,
    '',
    'Decida sozinho; só pergunte se realmente não der para decidir:',
    'RETOMAR_A | <o motivo> — o A recupera a vez quando o prompt atual do B terminar, e o B espera o A acabar para seguir.',
    'ESPERAR_B | <o motivo> — o A espera o plano B inteiro terminar.',
    'PERGUNTAR | <uma pergunta curta ao usuário> — raramente.',
    '',
    'Responda com UMA dessas linhas, sozinha, no fim.'
  ].join('\n')
}

function recordText(input: ProjectEvaluationInput, prompt: string, result: PoAgentResult | null, outcome: ProjectEvaluationOutcome): string {
  return [
    `# Avaliação do PO — ${input.kind === 'vez' ? 'a vez na fila do projeto' : 'a resposta guardada'}`,
    '',
    `- pasta: ${input.cwd}`,
    `- plano A: ${input.a.plan.planTitulo} (${input.a.plan.loteId})`,
    `- plano B: ${input.b.plan.planTitulo} (${input.b.plan.loteId})`,
    `- decisão: ${outcome.decisao}${outcome.falhou ? ' (saída fixa: o PO não decidiu)' : ''}`,
    `- motivo: ${outcome.motivo}`,
    ...(outcome.pergunta ? [`- pergunta: ${outcome.pergunta}`] : []),
    `- consulta: ${result ? `${result.state}, ${result.turns} turnos${result.error ? `, erro: ${result.error}` : ''}` : 'não rodou'}`,
    `- o PO alterou: ${outcome.alterados.length > 0 ? outcome.alterados.join(', ') : 'nada'}`,
    '',
    '## Ferramentas usadas',
    ...(result && result.tools.length > 0 ? result.tools.map((t) => `- ${t.name} ${t.input}`) : ['(nenhuma)']),
    '',
    '## Resposta do PO',
    result?.transcript || result?.text || '(vazia)',
    '',
    '## O pedido',
    prompt
  ].join('\n')
}

async function prune(recordsDir: string): Promise<void> {
  const names = (await readdir(recordsDir, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
  for (const name of names.slice(0, Math.max(0, names.length - PROJECT_RECORDS_KEEP))) {
    await rm(join(recordsDir, name), { recursive: true, force: true }).catch(() => undefined)
  }
}

export function createProjectEvaluator(deps: ProjectEvaluatorDeps): ProjectEvaluator {
  const run = deps.run ?? ((request: PoAgentRequest) => runPoAgentQuery(request))
  const now = deps.now ?? Date.now
  return async (input) => {
    const id = randomUUID()
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
    const dir = deps.recordsDir ? join(deps.recordsDir, `${stamp}-${input.kind}-${id.slice(0, 8)}`) : join(tmpdir(), 'agent-code-po', id)
    const files = { promptsA: join(dir, 'prompts-A.md'), historyA: join(dir, 'historico-A.md'), promptsB: join(dir, 'prompts-B.md') }
    let prompt = ''
    let result: PoAgentResult | null = null
    let alterados: string[] = []
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(files.promptsA, promptsFile(input.a.plan, input.a.envios), 'utf8')
      await writeFile(files.historyA, (await deps.history(input.a.plan.conversationId).catch(() => '')) || '(histórico indisponível)', 'utf8')
      await writeFile(files.promptsB, promptsFile(input.b.plan, input.b.envios), 'utf8')
      const evidence = await deps.gitEvidence(input.cwd, sinceOf(input.a.envios)).catch(() => null)
      const git = evidence ? formatPoGitEvidence(evidence) : 'GIT DA PASTA: (indisponível — a pasta não é repositório ou o git falhou)'
      prompt = input.kind === 'vez' ? turnPrompt(input, files, git) : replyPrompt(input, files, git)
      const before = await deps.git.snapshot(input.cwd)
      const runtime = await deps.runtime(input.a.plan.conversationId)
      result = await run({ prompt, cwd: input.cwd, model: runtime.model, ...(runtime.env ? { env: runtime.env } : {}), additionalDirectories: [dir], signal: input.signal })
      const after = await deps.git.snapshot(input.cwd)
      if (before && after) alterados = changedBetween(before, after)
    } catch (err) {
      result ??= { state: 'failed', text: '', transcript: '', tools: [], turns: 0, error: err instanceof Error ? err.message : String(err) }
    }
    const cancelled = input.signal.aborted || result?.state === 'aborted'
    const completed = result?.state === 'completed'
    let outcome: ProjectEvaluationOutcome
    if (input.kind === 'vez') {
      const parsed = completed ? parseTurnVerdict(result?.text ?? '') : null
      outcome = parsed
        ? { cancelled, ...parsed, falhou: false, alterados, registro: null }
        : { cancelled, decisao: 'ESPERAR', motivo: `o PO não conseguiu avaliar (${why(result, !completed)}); a fila espera você`, falhou: true, alterados, registro: null }
    } else {
      const parsed = completed ? parseReplyVerdict(result?.text ?? '') : null
      outcome = parsed
        ? parsed.decisao === 'PERGUNTAR'
          ? { cancelled, decisao: 'PERGUNTAR', motivo: parsed.motivo, pergunta: parsed.motivo, falhou: false, alterados, registro: null }
          : { cancelled, ...parsed, falhou: false, alterados, registro: null }
        : { cancelled, decisao: 'RETOMAR_A', motivo: `o PO não conseguiu decidir (${why(result, !completed)}); a sua resposta não fica presa`, falhou: true, alterados, registro: null }
    }
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'avaliacao.md'), recordText(input, prompt, result, outcome), 'utf8')
      outcome.registro = dir
      if (deps.recordsDir) await prune(deps.recordsDir)
    } catch {
      // Sem registro a decisão ainda vale; só não há o que abrir.
    }
    return outcome
  }
}
