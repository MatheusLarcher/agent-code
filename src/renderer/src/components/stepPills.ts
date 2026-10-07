/**
 * As pílulas da linha de passos do chat ("3 buscas", "2 lidos", "1 edição") e o
 * ícone do grupo — PURO. Contam as ferramentas de uma resposta por tipo, na ordem
 * em que cada tipo apareceu. O bastidor (plano, tarefas, pergunta, busca de
 * ferramenta) não conta, como no resumo da Central (activitySummary).
 *
 * E o "✓ N" dos cartões abertos: quantos resultados a busca achou, quantas
 * linhas a leitura trouxe.
 */

export type PillKind = 'search' | 'read' | 'edit' | 'bash' | 'web' | 'browser' | 'agent' | 'other'

export interface StepPill {
  kind: PillKind
  n: number
  /** O rótulo depois do número ("buscas", "lido"). */
  label: string
}

const IGNORED = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'AskUserQuestion', 'ToolSearch'])
const isIgnored = (name: string): boolean => IGNORED.has(name) || name.startsWith('mcp__tasks__')

const LABELS: Record<PillKind, [string, string]> = {
  search: ['busca', 'buscas'],
  read: ['lido', 'lidos'],
  edit: ['edição', 'edições'],
  bash: ['comando', 'comandos'],
  web: ['pesquisa', 'pesquisas'],
  browser: ['no navegador', 'no navegador'],
  agent: ['subagente', 'subagentes'],
  other: ['ferramenta', 'ferramentas']
}

export function pillKind(name: string): PillKind {
  switch (name) {
    case 'Grep':
    case 'Glob':
      return 'search'
    case 'Read':
    case 'WebFetch':
      return 'read'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Write':
      return 'edit'
    case 'Bash':
    case 'PowerShell':
      return 'bash'
    case 'WebSearch':
      return 'web'
    case 'Task':
    case 'Agent':
      return 'agent'
  }
  return name.startsWith('mcp__browser__') ? 'browser' : 'other'
}

export function stepPills(tools: readonly unknown[]): StepPill[] {
  const counts = new Map<PillKind, number>()
  for (const t of tools) {
    const name = t && typeof t === 'object' ? (t as { name?: unknown }).name : null
    if (typeof name !== 'string' || isIgnored(name)) continue
    const kind = pillKind(name)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts].map(([kind, n]) => ({ kind, n, label: LABELS[kind][n === 1 ? 0 : 1] }))
}

/** O ícone do grupo: lupa quando o grupo é de achar/ler, prompt quando mexe (edita/roda). */
export function stepIcon(pills: readonly StepPill[]): 'find' | 'code' | 'tool' {
  if (pills.length === 0) return 'tool'
  const top = pills.reduce((a, b) => (b.n > a.n ? b : a))
  if (top.kind === 'search' || top.kind === 'read' || top.kind === 'web') return 'find'
  return top.kind === 'edit' || top.kind === 'bash' ? 'code' : 'tool'
}

/** O número do "✓ N" de um cartão pronto: resultados da busca, linhas lidas; null = só o ✓. */
export function resultCount(name: string, result: { isError: boolean; text: string } | null | undefined): { n: number; unit: string } | null {
  if (!result || result.isError || typeof result.text !== 'string') return null
  const text = result.text.trim()
  if (name === 'Grep' || name === 'Glob') {
    if (!text || /^No (matches|files) found/i.test(text)) return { n: 0, unit: '' }
    const found = /^Found (\d+) /.exec(text)
    if (found) return { n: Number(found[1]), unit: '' }
    return { n: text.split('\n').filter((l) => l.trim() !== '').length, unit: '' }
  }
  if (name === 'Read') {
    const n = text.split('\n').filter((l) => /^\s*\d+[\t→]/.test(l)).length
    return n > 0 ? { n, unit: ' l' } : null
  }
  return null
}
