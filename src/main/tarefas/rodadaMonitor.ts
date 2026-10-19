import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createSdkMcpServer, query, tool, type McpServerConfig, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { dataHoraTexto } from '../../shared/tarefas'
import type { TarefaRegistro } from '../persistence/tarefaTypes'
import { claudeObserverEnv } from '../observerQuery'
import { isUsageExhausted, sdkUsageExhausted } from '../providerQuota'
import type { ContextoRodada } from './agendador'
import { MODELO_MONITOR_PADRAO } from './avisosMcp'
import type { ResultadoRodada } from './regras'

/**
 * UMA rodada do monitor: uma consulta própria do Agent SDK (molde do
 * poAgentQuery.ts), fora da sessão e do histórico da conversa. `cwd` da conversa,
 * modelo da tarefa, teto de turnos; o tempo e o cancelamento vêm do agendador
 * (`ctx.signal`). Ninguém olha: `bypassPermissions`, sem AskUserQuestion — o
 * risco foi combinado na criação. A rodada termina chamando `aviso_resultado`
 * (MCP só dela); sem a chamada, é falha. O CLI é fechado SEMPRE (`close()`), no
 * fim, no erro e no prazo. Nunca lança.
 */

export const RODADA_MAX_TURNS = 40
/** Fora da rodada: perguntar (ninguém responde), agendar de dentro e trocar de modo. */
export const RODADA_FERRAMENTAS_PROIBIDAS: readonly string[] = [
  'AskUserQuestion', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'RemoteTrigger', 'PushNotification', 'EnterPlanMode', 'ExitPlanMode'
]
const COMBINADO_PADRAO = 'só pesquisar e ler; nada de login, compra, envio de mensagem ou apagar algo'

export type RodadaQueryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<unknown> & { close?(): void }

export interface RodadaDeps {
  query?: RodadaQueryFn
  /** Conta Claude como a dos observadores (a da conversa, senão a de menor uso). */
  env?(convId: string, model: string): Promise<NodeJS.ProcessEnv | undefined>
  /** Chrome/Windows quando os interruptores do app estão ligados (ferramentasRodada.ts). */
  ferramentas?(convId: string): { servidores: Record<string, McpServerConfig>; encerrar(): void }
  /** O MCP do `aviso_resultado` (o teste troca por um que a consulta falsa chama direto). */
  servidorResultado?(guardar: (r: Resposta) => void): McpServerConfig
  log?(line: string): void
}

export interface Resposta {
  bateu: boolean
  valor?: string
  resumo?: string
  fonte?: string
  precisa_de_voce?: boolean
}

export function promptDaRodada(t: TarefaRegistro, agora: number): string {
  const ultima = t.ultimaEm
    ? `${dataHoraTexto(Date.parse(t.ultimaEm), agora)} — ${t.ultimoResultado ?? '?'}${t.ultimoValor ? ` (${t.ultimoValor})` : ''}`
    : 'nenhuma (esta é a primeira)'
  return [
    'Você é UMA rodada de um MONITOR agendado do Agent Code, rodando sozinho: ninguém está olhando e ninguém responde perguntas.',
    `Monitor: ${t.titulo}`,
    `Condição para avisar: ${t.condicao ?? t.titulo}`,
    `Combinado com o usuário (o que você pode e não pode fazer): ${t.combinado?.trim() || COMBINADO_PADRAO}`,
    `Última checagem: ${ultima}`,
    `Agora: ${dataHoraTexto(agora, agora - 86_400_000)} (horário de Brasília)`,
    '',
    '1. Verifique a condição AGORA, com as ferramentas que precisar (busca na web, páginas…), dentro do combinado.',
    '2. Termine chamando a ferramenta aviso_resultado UMA vez: bateu (true/false), valor (o que achou, curto, ex. "R$ 2.890"), resumo (uma frase) e fonte (URL ou de onde veio).',
    '3. Se não der para checar sem o usuário (login, captcha, decisão dele), chame aviso_resultado com bateu=false, precisa_de_voce=true e diga no resumo o que falta.',
    'Seja objetivo: uma checagem, sem trabalho extra, sem criar arquivos.'
  ].join('\n')
}

function servidorResultado(guardar: (r: Resposta) => void): McpServerConfig {
  return createSdkMcpServer({
    name: 'avisos',
    version: '1.0.0',
    tools: [
      tool(
        'aviso_resultado',
        'Registra o resultado desta checagem do monitor. Chame UMA vez, no fim.',
        {
          bateu: z.boolean().describe('true se a condição foi atendida agora.'),
          valor: z.string().max(200).optional().describe('O que foi encontrado, curto (ex. "R$ 2.890").'),
          resumo: z.string().max(500).optional().describe('Uma frase sobre o que viu.'),
          fonte: z.string().max(500).optional().describe('URL ou de onde veio o dado.'),
          precisa_de_voce: z.boolean().optional().describe('true se não deu para checar sem o usuário.')
        },
        async (input) => {
          guardar(input)
          return { content: [{ type: 'text', text: 'Resultado registrado. Encerre a rodada.' }] }
        }
      )
    ]
  })
}

export function rodadaOptions(
  t: TarefaRegistro,
  abortController: AbortController,
  env: NodeJS.ProcessEnv | undefined,
  servidores: Record<string, McpServerConfig>
): Options {
  return {
    cwd: t.cwd && existsSync(t.cwd) ? t.cwd : homedir(),
    model: t.modelo ?? MODELO_MONITOR_PADRAO,
    // Tarefa de fundo não pode sobreviver ao `close()` (processo órfão no Windows).
    env: { ...process.env, ...(env ?? {}), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' },
    executable: 'node',
    abortController,
    maxTurns: RODADA_MAX_TURNS,
    includePartialMessages: false,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    disallowedTools: [...RODADA_FERRAMENTAS_PROIBIDAS],
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settings: { autoMemoryEnabled: false },
    persistSession: false,
    mcpServers: servidores
  }
}

async function* singlePrompt(prompt: string): AsyncIterable<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null } as SDKUserMessage
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export async function executarRodadaMonitor(t: TarefaRegistro, ctx: ContextoRodada, deps: RodadaDeps = {}): Promise<ResultadoRodada> {
  const run = deps.query ?? (query as unknown as RodadaQueryFn)
  const abort = new AbortController()
  const onAbort = (): void => abort.abort()
  if (ctx.signal.aborted) return { resultado: 'falha', falha: 'cancelada antes de começar' }
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  let resposta: Resposta | null = null
  let esgotada: string | null = null
  let erro: string | null = null
  let q: (AsyncIterable<unknown> & { close?(): void }) | null = null
  let encerrar = (): void => undefined
  try {
    const model = t.modelo ?? MODELO_MONITOR_PADRAO
    const env = await (deps.env ?? claudeObserverEnv)(t.convId, model).catch(() => undefined)
    if (abort.signal.aborted) return { resultado: 'falha', falha: 'cancelada antes de começar' }
    let extras: Record<string, McpServerConfig> = {}
    try {
      const f = deps.ferramentas?.(t.convId)
      if (f) {
        extras = f.servidores
        encerrar = f.encerrar
      }
    } catch (error) {
      deps.log?.(`[tarefas] ferramentas extras da rodada indisponíveis: ${message(error)}`)
    }
    const servidores = { ...extras, avisos: (deps.servidorResultado ?? servidorResultado)((r) => (resposta ??= r)) }
    q = run({ prompt: singlePrompt(promptDaRodada(t, Date.now())), options: rodadaOptions(t, abort, env, servidores) })
    const parado = new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }))
    const consumir = async (): Promise<void> => {
      for await (const raw of q!) {
        if (abort.signal.aborted) break
        const m = raw as { type?: string; subtype?: string; error?: unknown; errors?: string[] }
        if (typeof m.error === 'string' && m.error !== 'max_output_tokens' && sdkUsageExhausted(raw)) esgotada ??= 'cota da conta Claude esgotada'
        if (m.type === 'result' && m.subtype !== 'success') erro ??= m.errors?.join('; ') || m.subtype || 'erro'
        // O resultado chegou: encerra já (a resposta final do modelo não serve para nada).
        if (resposta && (m.type === 'user' || m.type === 'result')) break
      }
    }
    await Promise.race([consumir(), parado])
  } catch (error) {
    if (isUsageExhausted(error)) esgotada ??= 'cota da conta Claude esgotada'
    erro ??= message(error)
  } finally {
    ctx.signal.removeEventListener('abort', onAbort)
    for (const fechar of [() => q?.close?.(), encerrar]) {
      try {
        fechar()
      } catch (error) {
        deps.log?.(`[tarefas] fechar a rodada falhou: ${message(error)}`)
      }
    }
  }
  const r = resposta as Resposta | null
  if (r) {
    const base = { valor: r.valor ?? null, resumo: r.resumo ?? null, fonte: r.fonte ?? null }
    if (r.precisa_de_voce) return { resultado: 'precisa-de-voce', ...base }
    return { resultado: r.bateu ? 'bateu' : 'nao-bateu', ...base }
  }
  if (ctx.signal.aborted) return { resultado: 'falha', falha: 'interrompida' }
  if (esgotada) return { resultado: 'falha', falha: esgotada }
  return { resultado: 'falha', falha: erro ? `a rodada falhou: ${erro}` : 'a rodada terminou sem aviso_resultado' }
}
