import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { WriteScope } from '../persistence/types'

/**
 * Imposição DETERMINÍSTICA do `write_scope` de uma tarefa, fora do LLM.
 *
 * A definição do multi-agent pede que "escopo e permissão sejam impostos fora do
 * modelo": pedir ao supervisor para "só mexer em src/tasks" é instrução, e
 * instrução o modelo esquece. Isto aqui é regra: enquanto a sessão tem uma tarefa
 * reivindicada com escopo declarado, `Write`/`Edit` fora dele é recusado no gate
 * de permissão — antes do "Permitir tudo", que é sobre o usuário confiar no
 * modelo, não sobre o modelo respeitar o contrato da tarefa.
 *
 * Sem tarefa com escopo, nada muda: o gate segue como sempre.
 */

export interface ScopedTask {
  id: string
  title: string
  projectCwd: string
  writeScope: WriteScope
  /**
   * Fim do lease (ISO). O escopo vale exatamente enquanto a posse vale: sem
   * isto, um subagente que morre sem transicionar deixaria a sessão restrita
   * para sempre, e o supervisor nunca mais escreveria fora daquele escopo.
   * Cada escrita renova o lease, então um executor vivo nunca expira.
   */
  leaseExpiresAt: string
  /**
   * Qual agente reivindicou: `null` = o agente principal (supervisor).
   * Escopo do supervisor vale para todo mundo (ele é o dono da conversa);
   * escopo de um subagente prende só aquele subagente — senão um executor
   * trabalhando em `src/tasks/**` impediria o supervisor de escrever em
   * qualquer outro lugar enquanto delega.
   */
  holder: string | null
}

/** O escopo de uma tarefa só vincula quem o detém (e todo mundo, se for do supervisor). */
export function bindsAgent(task: ScopedTask, agentId: string | null): boolean {
  return task.holder === null || task.holder === agentId
}

/** Tarefas cuja posse ainda vale para este agente, agora. */
export function activeScopesFor(
  tasks: Iterable<ScopedTask>,
  agentId: string | null,
  now = Date.now()
): ScopedTask[] {
  return [...tasks].filter((task) => Date.parse(task.leaseExpiresAt) > now && bindsAgent(task, agentId))
}

/** Ferramentas que gravam arquivo e o campo que traz o caminho. */
const FILE_TOOLS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path'
}

function canon(p: string): string {
  const s = p.split(sep).join('/')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/**
 * Glob → RegExp, o subconjunto que escopo de tarefa usa: `**` (qualquer
 * profundidade, inclusive nenhuma), `*` (dentro de um segmento), `?`. Um glob
 * sem barra casa em qualquer pasta (`*.test.ts` = `**\/*.test.ts`), que é como
 * quem escreve o escopo espera que funcione. Um glob que nomeia uma pasta
 * (`src/tasks`) cobre o que está dentro dela.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!g.includes('/')) g = `**/${g}`
  let out = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` casa zero ou mais pastas; `**` no fim casa tudo.
        const slash = g[i + 2] === '/'
        out += slash ? '(?:.*/)?' : '.*'
        i += slash ? 2 : 1
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c
    }
  }
  // Pasta nomeada cobre os filhos.
  return new RegExp(`^${out}(?:/.*)?$`, process.platform === 'win32' ? 'i' : '')
}

function matchesAny(rel: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(rel))
}

/** Caminho relativo ao projeto, ou `null` se cair fora dele. */
export function relativeToProject(projectCwd: string, filePath: string): string | null {
  const abs = isAbsolute(filePath) ? filePath : resolve(projectCwd, filePath)
  const rel = relative(projectCwd, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return rel === '' ? '' : null
  return canon(rel)
}

/**
 * `null` = pode escrever. Texto = motivo da recusa, legível pelo modelo.
 *
 * Regra: a escrita é permitida se AO MENOS UMA tarefa ativa a autoriza —
 * dentro do projeto dela, casando um `allow` (ou `allow` vazio = tudo do
 * projeto) e nenhum `deny`. Tarefas sem escopo nenhum não contam para nada.
 */
export function writeScopeDenial(
  tasks: readonly ScopedTask[],
  toolName: string,
  input: Record<string, unknown>
): string | null {
  const field = FILE_TOOLS[toolName]
  if (!field) return null
  const scoped = tasks.filter((t) => t.writeScope.allow.length || t.writeScope.deny.length)
  if (!scoped.length) return null
  const filePath = input[field]
  if (typeof filePath !== 'string' || !filePath.trim()) return null

  const reasons: string[] = []
  for (const task of scoped) {
    const rel = relativeToProject(task.projectCwd, filePath)
    if (rel === null) {
      reasons.push(`fora do projeto da tarefa "${task.title}" (${task.projectCwd})`)
      continue
    }
    if (task.writeScope.deny.length && matchesAny(rel, task.writeScope.deny)) {
      reasons.push(`"${rel}" está no deny da tarefa "${task.title}": ${task.writeScope.deny.join(', ')}`)
      continue
    }
    if (task.writeScope.allow.length && !matchesAny(rel, task.writeScope.allow)) {
      reasons.push(`"${rel}" não casa o allow da tarefa "${task.title}": ${task.writeScope.allow.join(', ')}`)
      continue
    }
    return null
  }
  return (
    `${toolName} recusado pelo escopo de escrita da tarefa em andamento — ${reasons.join('; ')}. ` +
    'Se esse arquivo precisa mudar, registre um task_event "blocker" com o caminho e devolva a tarefa ao supervisor ' +
    '(task_transition para "review" ou "blocked", com o motivo). O supervisor abre outra tarefa com o escopo certo. ' +
    'Não contorne por Bash: o escopo é o contrato da tarefa, não um obstáculo técnico.'
  )
}
