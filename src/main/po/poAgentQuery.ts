import { query, type CanUseTool, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * O MODO "PO COM FERRAMENTAS": uma consulta do Agent SDK com as ferramentas do
 * agente normal (ler o projeto, rodar git, abrir arquivos), `cwd` = a pasta do
 * projeto e as mesmas fontes de configuração do agente normal. É para os casos
 * raros em que o PO precisa olhar o projeto de verdade: a vez na fila do projeto
 * e, no prompt 4, a verificação de verdade. O PO de todo turno (observerQuery)
 * continua sem ferramenta e em 1 turno.
 *
 * Travas de código, que valem em qualquer modo de permissão:
 * - `disallowedTools` com escopo: commit, push, reset, checkout, restore, stash e
 *   clean do git. Commitar, descartar ou reverter o trabalho dos outros é
 *   justamente o que atrapalha;
 * - `permissionMode: 'auto'` (um classificador revisa comandos e rede). O que
 *   ele não decide cai no `canUseTool`, que NEGA: ninguém está olhando;
 * - teto de turnos e de tempo. Estourou: a consulta é abortada, e quem chamou
 *   aplica a saída fixa dele (ESPERAR, RETOMAR_A…).
 *
 * Doc das opções: https://code.claude.com/docs/en/agent-sdk/typescript
 */

export const PO_AGENT_DISALLOWED_TOOLS: readonly string[] = [
  'Bash(git commit*)',
  'Bash(git push*)',
  'Bash(git reset*)',
  'Bash(git checkout*)',
  'Bash(git restore*)',
  'Bash(git stash*)',
  'Bash(git clean*)'
]
export const PO_AGENT_MAX_TURNS = 30
export const PO_AGENT_TIMEOUT_MS = 10 * 60_000
/** Teto de cada entrada de ferramenta no registro (o registro não vira o transcript inteiro). */
const TOOL_INPUT_CHARS = 300

/** A orientação de todo PO com ferramentas (pedido do usuário). */
export const PO_AGENT_SYSTEM_APPEND = [
  'Você está rodando como o PO do Agent Code, sozinho: ninguém está olhando agora.',
  '- Evite modificar arquivos. Só altere algo se for realmente necessário e se não atrapalhar os outros agentes que trabalham nesta pasta.',
  '- Nunca faça commit, push, reset, checkout, restore, stash nem clean: o app bloqueia esses comandos, e mexer no trabalho dos outros é justamente o que atrapalha.',
  '- Leia o que precisar (arquivos do projeto, os arquivos indicados no pedido, git status/diff/log) antes de decidir.',
  '- Termine com a linha do formato fixo pedido, sozinha, como a última linha da resposta.'
].join('\n')

export interface PoAgentRequest {
  prompt: string
  cwd: string
  model: string
  env?: NodeJS.ProcessEnv
  /** Pastas fora do projeto que o PO lê (os arquivos exportados para a avaliação). */
  additionalDirectories?: string[]
  maxTurns?: number
  timeoutMs?: number
  /** Cancelamento de fora: o usuário respondeu, passou a vez ou começou mesmo assim. */
  signal?: AbortSignal
  /** Ganchos do SDK (a verificação do "Fala, PO" barra comando pesado com agente rodando). */
  hooks?: Options['hooks']
  /** Servidores MCP extras (o `app_anexar_print` da verificação). */
  mcpServers?: Options['mcpServers']
}

export interface PoAgentToolCall {
  name: string
  input: string
}

export interface PoAgentResult {
  state: 'completed' | 'failed' | 'timeout' | 'aborted' | 'max-turns'
  /** A resposta final (onde fica a linha do formato fixo). */
  text: string
  /** Todo o texto do assistente, na ordem — vai para o registro. */
  transcript: string
  tools: PoAgentToolCall[]
  turns: number
  error?: string
}

export type PoAgentQueryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<unknown>

/** Ninguém olhando: o que o classificador não aprova, ninguém aprova. */
const denyUnattended: CanUseTool = async (toolName) => ({
  behavior: 'deny',
  message: `Ninguém está olhando para aprovar "${toolName}": siga sem esta ferramenta e decida com o que já tem.`
})

/** As opções da consulta, à parte para o teste conferir as travas. */
export function poAgentOptions(req: PoAgentRequest, abortController: AbortController): Options {
  const dirs = [...new Set(req.additionalDirectories ?? [])].filter(Boolean)
  return {
    cwd: req.cwd,
    model: req.model,
    ...(req.env ? { env: req.env } : {}),
    // O CLI empacotado roda no Node do sistema, não no binário do Electron.
    executable: 'node',
    abortController,
    maxTurns: req.maxTurns ?? PO_AGENT_MAX_TURNS,
    includePartialMessages: false,
    permissionMode: 'auto',
    disallowedTools: [...PO_AGENT_DISALLOWED_TOOLS],
    canUseTool: denyUnattended,
    // As mesmas fontes de configuração do agente normal (agentSession.ts).
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: PO_AGENT_SYSTEM_APPEND },
    settings: { autoMemoryEnabled: false },
    // Avaliação descartável: não entra na lista de sessões do usuário.
    persistSession: false,
    ...(dirs.length > 0 ? { additionalDirectories: dirs } : {}),
    ...(req.hooks ? { hooks: req.hooks } : {}),
    ...(req.mcpServers ? { mcpServers: req.mcpServers } : {})
  }
}

async function* singlePrompt(prompt: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    parent_tool_use_id: null
  } as SDKUserMessage
}

function brief(input: unknown): string {
  let text: string
  try {
    text = typeof input === 'string' ? input : JSON.stringify(input)
  } catch {
    text = String(input)
  }
  return text.length > TOOL_INPUT_CHARS ? `${text.slice(0, TOOL_INPUT_CHARS - 1)}…` : text
}

type Block = { type?: string; text?: string; name?: string; input?: unknown }

/**
 * Roda UMA consulta do modo PO com ferramentas. Nunca lança: falha, prazo,
 * teto de turnos e cancelamento voltam como `state`, e quem chamou decide a
 * saída fixa.
 */
export async function runPoAgentQuery(req: PoAgentRequest, run: PoAgentQueryFn = query as unknown as PoAgentQueryFn): Promise<PoAgentResult> {
  const abort = new AbortController()
  let timedOut = false
  let cancelled = false
  const timer = setTimeout(() => {
    timedOut = true
    abort.abort()
  }, req.timeoutMs ?? PO_AGENT_TIMEOUT_MS)
  timer.unref?.()
  const onCancel = (): void => {
    cancelled = true
    abort.abort()
  }
  if (req.signal?.aborted) onCancel()
  else req.signal?.addEventListener('abort', onCancel, { once: true })

  const transcript: string[] = []
  const tools: PoAgentToolCall[] = []
  let lastText = ''
  let finalText: string | null = null
  let turns = 0
  let state: PoAgentResult['state'] = 'failed'
  let error: string | undefined
  // Cancelada ou no prazo: volta na hora. O SDK encerra o CLI ao fundo (no
  // Windows ele espera a saída educada por até ~7 s antes de matar o processo).
  const stopped = new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }))
  const consume = async (): Promise<void> => {
    for await (const raw of run({ prompt: singlePrompt(req.prompt), options: poAgentOptions(req, abort) })) {
      if (abort.signal.aborted) break
      const message = raw as { type?: string; subtype?: string; message?: { content?: Block[] }; result?: string; num_turns?: number; errors?: string[] }
      if (message.type === 'assistant') {
        const blocks = message.message?.content ?? []
        const text = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string).join('')
        if (text.trim()) {
          lastText = text
          transcript.push(text)
        }
        for (const block of blocks) if (block.type === 'tool_use') tools.push({ name: String(block.name ?? '?'), input: brief(block.input) })
      }
      if (message.type === 'result') {
        turns = typeof message.num_turns === 'number' ? message.num_turns : turns
        if (message.subtype === 'success') {
          state = 'completed'
          if (typeof message.result === 'string' && message.result.trim()) finalText = message.result
        } else {
          state = message.subtype === 'error_max_turns' ? 'max-turns' : 'failed'
          error = message.errors?.join('; ') || message.subtype
        }
      }
    }
  }
  try {
    if (cancelled) throw new Error('cancelada antes de começar')
    await Promise.race([consume(), stopped])
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    state = 'failed'
  } finally {
    clearTimeout(timer)
    req.signal?.removeEventListener('abort', onCancel)
  }
  if (timedOut) state = 'timeout'
  else if (cancelled) state = 'aborted'
  return {
    state,
    text: (finalText ?? lastText).trim(),
    transcript: transcript.join('\n\n'),
    tools,
    turns,
    ...(error ? { error } : {})
  }
}
