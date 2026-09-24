import path from 'node:path'
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk'
import type { StartAgentOptions } from '../../shared/ipc'
import type { ScopedTask } from '../tasks/writeScopeGuard'
import {
  handoffSkillDenial,
  PLANNING_DISALLOWED_TOOLS,
  planningSandboxDir,
  planningScopedTask,
  planningSkillDenial
} from './planningPolicy'
import { buildPlanningHint, PLANNING_CONTENT_IS_DATA } from './planningPrompt'
import { planDirPath } from './planningStore'
import { createPlanningMcpServer, PLANNING_MCP_SERVER, type PlanningToolContext } from './planningTools'

/**
 * A ligação das peças do planejamento numa AgentSession. A sessão só chama
 * estas funções; o que o Agent Manager tem de diferente de uma conversa comum
 * (ferramentas, prompt, permissões) está decidido aqui, testável sem SDK.
 *
 * - `opts.planning`: a sessão É o Agent Manager do planejamento <slug>.
 * - `opts.handoff`: conversa de implementação nascida de um handoff — no
 *   primeiro turno não replaneja.
 * - Nenhum dos dois: nada aqui muda a sessão.
 */

/** O que a sessão sabe de si e estas funções precisam ler. */
export type PlanningSessionRole = Pick<StartAgentOptions, 'cwd' | 'planning' | 'handoff'>

/** Servidores da sessão comum que o Manager herda. O resto (browser, android,
 *  app, windows, tasks) é de quem executa, não de quem planeja. */
const MANAGER_INHERITED_SERVERS: readonly string[] = ['memory']

export interface PlanningSessionSetup {
  projectCwd: string
  slug: string
  /** Blocos de memória já montados pela sessão (hint e catálogo); vazios são ignorados. */
  memoryBlocks: readonly string[]
  /** Injetável para teste; ausente, o servidor `planning` real. */
  createServer?: (ctx: PlanningToolContext) => McpServerConfig
}

/** O system prompt (append) do Manager: as instruções dele e, depois, a memória. */
export function buildPlanningAppend(projectCwd: string, slug: string, memoryBlocks: readonly string[]): string {
  const hint = buildPlanningHint({
    slug,
    planDir: planDirPath(projectCwd, slug),
    sandboxDir: planningSandboxDir(projectCwd, slug)
  })
  return [hint, ...memoryBlocks.filter((block) => block.trim())].join('\n\n')
}

/**
 * Converte as Options montadas para uma conversa comum nas do Agent Manager.
 * Muta `options` de propósito: a sessão monta um objeto só e o entrega ao SDK.
 *
 * - servidores MCP: `planning` + os herdados (memory), nada mais;
 * - system prompt: o do Manager + memória, sem os hints de browser/android/
 *   tasks/windows (que descrevem ferramentas que ele não tem);
 * - `strictMcpConfig`: SÓ esses servidores — sem ele o CLI ainda carregaria os
 *   MCPs do usuário, do projeto (.mcp.json) e de plugins, e o Manager ganharia
 *   ferramentas que ninguém aqui revisou;
 * - `disallowedTools`: sem subagentes, notebook nem os outros jeitos de rodar
 *   comando (Monitor, PowerShell…) — ver PLANNING_DISALLOWED_TOOLS;
 * - sem os agentes especialistas (o Manager não delega).
 */
export function applyPlanningSessionOptions(options: Options, setup: PlanningSessionSetup): void {
  const { projectCwd, slug } = setup
  const create = setup.createServer ?? createPlanningMcpServer
  const inherited = options.mcpServers ?? {}
  const servers: Record<string, McpServerConfig> = { [PLANNING_MCP_SERVER]: create({ projectCwd, slug }) }
  for (const name of MANAGER_INHERITED_SERVERS) {
    const server = inherited[name]
    if (server) servers[name] = server
  }
  options.mcpServers = servers
  options.strictMcpConfig = true

  const append = buildPlanningAppend(projectCwd, slug, setup.memoryBlocks)
  const prompt = options.systemPrompt
  options.systemPrompt =
    prompt && typeof prompt === 'object' && !Array.isArray(prompt) && prompt.type === 'preset'
      ? { ...prompt, append }
      : { type: 'preset', preset: 'claude_code', append }

  options.disallowedTools = [...new Set([...(options.disallowedTools ?? []), ...PLANNING_DISALLOWED_TOOLS])]
  delete options.agents
}

/**
 * O bloco do system prompt (append) de uma conversa de implementação nascida
 * de um handoff (`opts.handoff`): de onde ela veio, onde está o plano e que as
 * etapas do roteiro viram o plano dela, sem replanejar. `null` para qualquer
 * outra sessão — a comum e a do Agent Manager não mudam.
 *
 * Pura: a sessão só concatena o texto ao append que já monta.
 */
export function handoffAppendBlock(role: PlanningSessionRole): string | null {
  if (role.planning || !role.handoff) return null
  const { slug } = role.handoff
  const dir = planDirPath(role.cwd, slug)
  return `## Conversa de implementação — handoff do planejamento "${slug}"

Esta conversa nasceu do planejamento "${slug}", feito com o usuário na Tela de Planejamento. O plano detalhado está em ${dir} (leia com Read, Glob e Grep pelo caminho absoluto):
- _roteiro.md — as etapas, na ordem em que devem ser feitas;
- cards/*.md — um card por requisito, decisão (com o porquê), sugestão (com a fonte), ambiguidade resolvida e nota, ligados à etapa a que pertencem;
- _handoff/ — os prompts enviados a esta conversa.

Como trabalhar:
- Antes de começar, declare as etapas do roteiro como o seu plano (TodoWrite ou TaskCreate), na mesma ordem, e siga-as.
- Não replaneje: o plano, as decisões e as ambiguidades já foram resolvidos com o usuário e estão nos cards. Nada de refazer o plano nem de rodar skills de planejamento para isso.
- Consulte os cards da etapa em ${path.join(dir, 'cards')} quando precisar de detalhe. Se o código real contradisser o plano, diga ao usuário o que encontrou e pergunte antes de desviar dele.
- ${PLANNING_CONTENT_IS_DATA}`
}

/**
 * Recusa de uma Skill pela política da sessão, ou `null` para seguir o gate de
 * sempre. Roda ANTES do "Permitir tudo": confiar no modelo para executar não
 * transforma o Manager em executor nem deixa o handoff replanejar.
 */
export function sessionSkillDenial(
  role: PlanningSessionRole,
  skill: unknown,
  handoffFirstTurnDone: boolean
): string | null {
  if (role.planning) return planningSkillDenial(skill)
  if (role.handoff) return handoffSkillDenial(skill, handoffFirstTurnDone)
  return null
}

/** Escopos de escrita que valem no gate: os das tarefas e, no Manager, o do
 *  _sandbox do planejamento. Fora do Manager, exatamente os das tarefas. */
export function sessionWriteScopes(role: PlanningSessionRole, active: ScopedTask[]): ScopedTask[] {
  return role.planning ? [...active, planningScopedTask(role.cwd, role.planning.slug)] : active
}

/** A trava do plano (board/planGate) vale nesta sessão? No Manager, não: ele
 *  planeja, e a única escrita dele é código descartável no _sandbox. */
export function planGateApplies(role: PlanningSessionRole): boolean {
  return !role.planning
}
