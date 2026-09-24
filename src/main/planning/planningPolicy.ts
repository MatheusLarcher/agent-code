import { scanBashWrites } from '../tasks/bashWriteScan'
import { writeScopeDenial, type ScopedTask } from '../tasks/writeScopeGuard'
import { assertValidName } from './planningModel'
import { planSandboxDirPath } from './planningRoot'
import { sandboxRealPathDenial } from './planningSandboxReal'

/**
 * A política de permissão das sessões ligadas ao planejamento — sem sessão nem
 * SDK. A agentSession a aplica no gate (canUseTool) e no hook PreToolUse.
 *
 * - Agent Manager: ALLOWLIST de ferramentas (MANAGER_ALLOWED_TOOLS + os
 *   servidores planning e memory). O que não está nela é negado — inclusive
 *   ferramentas que o CLI embutido ganhar numa versão futura.
 * - Escreve SOMENTE em docs/spec/<slug>/_sandbox/** do projeto (código de
 *   teste descartável), conferido como texto (glob do writeScopeGuard) e pelo
 *   caminho real (planningSandboxReal: junction/symlink para fora é negado).
 *   Cards e roteiro (na pasta de dados do app, fora do projeto) só mudam pelas
 *   ferramentas plan_*, que gravam pelo planningStore — nunca por Write/Edit/Bash.
 * - Bash é o único shell, e cada comando pede aprovação — só o "Permitir
 *   tudo" o libera (a agentSession aplica).
 * - Sem skills de execução/replanejamento: o plano vive nos cards.
 * - Conversa de handoff: no primeiro turno, nada de replanejar — o plano veio
 *   pronto no prompt.
 */

/** Um lease que não expira: o escopo vale enquanto a sessão do Manager existir. */
export const PLANNING_SCOPE_NEVER_EXPIRES = '9999-12-31T23:59:59.999Z'

/** Glob (relativo ao projeto) da única área que o Manager pode gravar. */
export function planningSandboxGlob(slug: string): string {
  assertValidName(slug, 'slug')
  return `docs/spec/${slug}/_sandbox/**`
}

/** Pasta absoluta do _sandbox do planejamento (para o prompt do Manager). Fica
 *  no projeto, em docs/spec/<slug>/_sandbox — o plano em si mora na pasta de
 *  dados do app, fora do projeto, e por isso fora do escopo de escrita. */
export function planningSandboxDir(projectCwd: string, slug: string): string {
  return planSandboxDirPath(projectCwd, slug)
}

/**
 * O escopo de escrita do Agent Manager como um ScopedTask do writeScopeGuard:
 * allow só o _sandbox do slug, holder null (vale para a sessão toda, inclusive
 * qualquer subagente) e lease que não expira.
 */
export function planningScopedTask(projectCwd: string, slug: string): ScopedTask {
  return {
    id: `planning:${slug}`,
    title: `Agent Manager do planejamento ${slug}`,
    projectCwd,
    writeScope: { allow: [planningSandboxGlob(slug)], deny: [] },
    leaseExpiresAt: PLANNING_SCOPE_NEVER_EXPIRES,
    holder: null
  }
}

/**
 * Ferramentas nativas que a sessão do Manager nem recebe (`disallowedTools`):
 * subagentes, notebook, os outros jeitos de rodar comando (Monitor roda um
 * `command` de shell; PowerShell é o Bash por outro nome), fluxos, worktree,
 * agendamento e gatilho remoto. A allowlist abaixo já as nega; tirá-las da
 * lista do modelo evita que ele gaste turno tentando.
 */
export const PLANNING_DISALLOWED_TOOLS: readonly string[] = [
  'Agent',
  'Task',
  'NotebookEdit',
  'Monitor',
  'PowerShell',
  'Workflow',
  'EnterWorktree',
  'CronCreate',
  'RemoteTrigger'
]

/**
 * As ferramentas nativas que o Agent Manager pode chamar. Leitura, escrita
 * (com o escopo do _sandbox), Bash (com escopo e aprovação), pesquisa na web,
 * a lista de tarefas nativa, pergunta ao usuário, Skill (com planningSkillDenial)
 * e ToolSearch. Todo o resto é negado.
 */
export const MANAGER_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'Write',
  'Edit',
  'MultiEdit',
  'Bash',
  'BashOutput',
  'KillShell',
  'KillBash',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'AskUserQuestion',
  'Skill',
  'ToolSearch'
])

/** Servidores MCP cujas ferramentas o Manager pode chamar (ver MANAGER_INHERITED_SERVERS). */
const MANAGER_ALLOWED_MCP_PREFIXES: readonly string[] = ['mcp__planning__', 'mcp__memory__']

/**
 * `null` = a ferramenta está na allowlist do Agent Manager (ou a sessão não é o
 * Manager). Texto = motivo da recusa, legível pelo modelo.
 */
export function planningToolDenial(role: { planning?: unknown }, toolName: string): string | null {
  if (!role.planning) return null
  if (MANAGER_ALLOWED_TOOLS.has(toolName)) return null
  if (MANAGER_ALLOWED_MCP_PREFIXES.some((prefix) => toolName.startsWith(prefix))) return null
  return (
    `A ferramenta "${toolName}" não está disponível na sessão do Agent Manager. ` +
    'Aqui valem: leitura (Read, Glob, Grep, LS), escrita só no _sandbox (Write, Edit, MultiEdit), ' +
    'Bash (o único shell, cada comando com aprovação do usuário), pesquisa na web (WebFetch, WebSearch), ' +
    'a lista de tarefas (TodoWrite, TaskCreate, TaskUpdate, TaskList, TaskGet), AskUserQuestion, Skill, ToolSearch ' +
    'e as ferramentas mcp__planning__* e mcp__memory__*.'
  )
}

/**
 * Shells do Manager: cada chamada pede aprovação do usuário. PowerShell nem
 * passa da allowlist; fica aqui para, se um dia entrar nela, entrar perguntando.
 */
const MANAGER_ALWAYS_ASK_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell'])

/**
 * `true` = no Agent Manager esta ferramenta não é auto-aprovada por um
 * "sempre permitir" anterior nem por lista de leitura — vai ao pedido de
 * permissão, a menos que o "Permitir tudo" esteja ligado (a agentSession
 * confere). As recusas de escopo (escrita fora do _sandbox) continuam antes
 * disto e negam sem perguntar, com ou sem "Permitir tudo".
 */
export function planningRequiresBashApproval(role: { planning?: unknown }, toolName: string): boolean {
  return Boolean(role.planning) && MANAGER_ALWAYS_ASK_TOOLS.has(toolName)
}

/** O que o hook PreToolUse do Agent Manager devolve ao SDK. */
export interface PlanningPreToolDecision {
  decision: 'deny' | 'ask'
  reason: string
}

/**
 * A política do Agent Manager no hook PreToolUse — a MESMA do gate
 * (canUseTool), repetida onde as regras de permissão do settings.json não
 * chegam: um `allow` de Bash/Edit/Write nelas é aplicado pelo SDK ANTES do
 * canUseTool, que então nem é consultado. O PreToolUse roda antes dessas
 * regras, e o `deny`/`ask` dele prevalece sobre um `allow` delas.
 *
 * - ferramenta fora da allowlist do Manager: `deny` (planningToolDenial);
 * - Skill de execução/replanejamento: `deny` (planningSkillDenial);
 * - escrita que o escopo do _sandbox recusa (Write/Edit/MultiEdit, Bash com
 *   destino fora de docs/spec/<slug>/_sandbox/** ou não determinável): `deny`,
 *   com o motivo do writeScopeDenial;
 * - escrita que casa o glob mas cujo caminho REAL sai do _sandbox (junction,
 *   symlink, link quebrado): `deny` (sandboxRealPathDenial);
 * - Bash que o escopo não recusou: `ask` — o SDK consulta o canUseTool, que
 *   leva o pedido ao usuário;
 * - o resto, e qualquer sessão que não seja o Manager: `null` (o hook não opina).
 */
export async function planningPreToolDecision(
  role: { cwd: string; planning?: { slug: string } | null },
  toolName: string,
  toolInput: unknown
): Promise<PlanningPreToolDecision | null> {
  if (!role.planning) return null
  const notAllowed = planningToolDenial(role, toolName)
  if (notAllowed) return { decision: 'deny', reason: notAllowed }
  // Entrada vinda do SDK/modelo: sem objeto, nada a conferir (o writeScopeDenial
  // também deixa passar caminho ausente; o gate de sempre decide depois).
  const input =
    toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>)
      : {}
  if (toolName === 'Skill') {
    // Repetida aqui pelo mesmo motivo do escopo: um `allow` de Skill no
    // settings.json pularia o canUseTool.
    const skillDenial = planningSkillDenial(typeof input.skill === 'string' ? input.skill : input.name)
    if (skillDenial) return { decision: 'deny', reason: skillDenial }
  }
  const { slug } = role.planning
  const denial = writeScopeDenial([planningScopedTask(role.cwd, slug)], toolName, input)
  if (denial) return { decision: 'deny', reason: denial }
  const realDenial = await sandboxRealPathDenial(role.cwd, slug, toolName, writeTargets(toolName, input))
  if (realDenial) return { decision: 'deny', reason: realDenial }
  if (planningRequiresBashApproval(role, toolName)) {
    return {
      decision: 'ask',
      reason: `No Agent Manager, cada comando de ${toolName} passa pela aprovação do usuário.`
    }
  }
  return null
}

/** Os destinos de escrita de uma chamada, como o writeScopeGuard os lê. */
function writeTargets(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
    const filePath = input.file_path
    return typeof filePath === 'string' && filePath.trim() ? [filePath] : []
  }
  if (toolName === 'Bash') {
    const command = input.command
    // Destino indeterminável (`unbounded`) o writeScopeDenial já negou.
    return typeof command === 'string' && command.trim() ? scanBashWrites(command).targets : []
  }
  return []
}

/** Skills que executam ou replanejam — fora de lugar na sessão do Manager. */
const MANAGER_BLOCKED_SKILLS = [
  'planejar',
  'brainstorming',
  'writing-plans',
  'executing-plans',
  'subagent-driven-development',
  'finishing-a-development-branch',
  'using-git-worktrees'
] as const

/** Skills de (re)planejamento — bloqueadas no primeiro turno de um handoff. */
const HANDOFF_FIRST_TURN_BLOCKED_SKILLS = ['planejar', 'brainstorming', 'writing-plans'] as const

/**
 * Nome comparável de uma skill: minúsculas, sem "/" inicial e sem o prefixo de
 * plugin ou de pasta ("superpowers:brainstorming" → "brainstorming").
 */
export function normalizeSkillName(skillName: unknown): string {
  if (typeof skillName !== 'string') return ''
  const trimmed = skillName.trim().toLowerCase().replace(/^\/+/, '')
  const colon = trimmed.lastIndexOf(':')
  return colon >= 0 ? trimmed.slice(colon + 1) : trimmed
}

/** A skill é `base` ou uma variante dela (`base.algo`, `base-algo`, `base_algo`). */
function isSkillOrVariant(name: string, base: string): boolean {
  if (name === base) return true
  if (!name.startsWith(base)) return false
  return ['.', '-', '_'].includes(name[base.length])
}

function blockedBy(skillName: unknown, list: readonly string[]): string | null {
  const name = normalizeSkillName(skillName)
  if (!name) return null
  return list.find((base) => isSkillOrVariant(name, base)) ?? null
}

/**
 * `null` = a skill pode rodar na sessão do Agent Manager. Texto = motivo da
 * recusa, legível pelo modelo.
 */
export function planningSkillDenial(skillName: unknown): string | null {
  const base = blockedBy(skillName, MANAGER_BLOCKED_SKILLS)
  if (!base) return null
  return (
    `A skill "${String(skillName)}" (${base}) é de execução ou de replanejamento e não roda na sessão do Agent Manager. ` +
    'Aqui o plano vive no roteiro e nos cards: use as ferramentas mcp__planning__plan_* para registrar etapas, ' +
    'decisões, sugestões e ambiguidades. A implementação acontece depois, na conversa de handoff.'
  )
}

/**
 * `null` = a skill pode rodar na conversa de handoff. Enquanto o primeiro turno
 * não terminou, planejar/brainstorming/writing-plans são recusadas: o plano já
 * foi feito na Tela de Planejamento e chegou no prompt.
 */
export function handoffSkillDenial(skillName: unknown, firstTurnDone: boolean): string | null {
  if (firstTurnDone) return null
  const base = blockedBy(skillName, HANDOFF_FIRST_TURN_BLOCKED_SKILLS)
  if (!base) return null
  return (
    `A skill "${String(skillName)}" (${base}) está bloqueada no primeiro turno desta conversa de handoff: ` +
    'o plano já foi feito na Tela de Planejamento e veio no prompt (gravado em _handoff/ da pasta do planejamento). ' +
    'Execute a partir dele — replanejar agora descartaria as decisões registradas nos cards. ' +
    'Depois do primeiro turno a skill volta a ficar disponível, se o usuário pedir.'
  )
}
