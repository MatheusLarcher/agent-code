/**
 * As ferramentas do MCP de entrada. Toda entrada passa por zod aqui, na
 * fronteira; um erro de validação volta como resultado `isError` legível (o
 * cliente mostra ao usuário), nunca como exceção.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { ImageAttachment, PermissionResponse } from '../../shared/ipc'
import { readableMediaText } from '../../shared/inlineMedia'
import { selectableModelIds } from '../../shared/selectableModels'
import { MCP_PLANNING_REFUSED, MCP_TASK_MODEL, RESERVED_MCP_SERVER_NAMES } from './mcpConstants'
import type { McpToolDefinition, McpToolResult, McpToolsApi } from './mcpHttpServer'
import { buildImageMessage, checkImage, MCP_IMAGE_MIMES, MCP_MAX_IMAGES, McpImagesArg } from './mcpImages'
import type { McpConversationConfig, McpStdioServer, McpTask, McpTaskRegistry } from './mcpTasks'

export interface McpDelivery {
  taskId: string
  convId: string
  /** Com imagens, já leva `{{midia:N}}` no lugar de cada uma. */
  text: string
  /** Presente quando a conversa é nova: o renderer a cria com estes dados. */
  create?: { cwd: string; title: string }
  /** O modelo desta tarefa (o pedido ou o padrão das tarefas MCP). */
  model: string
  /** As imagens do chamador, rotuladas `midia:N = nome`, na ordem N. */
  images?: ImageAttachment[]
}

export interface McpToolsDeps {
  registry: McpTaskRegistry
  /** A conversa existe no banco (não precisa estar carregada na tela)? */
  conversationExists: (convId: string) => Promise<boolean>
  /** A conversa é do Agent Manager (planejamento)? Destino recusado: o modelo
   *  dela é o do planejamento, não o da tarefa. Ausente: nenhuma é. */
  conversationIsPlanning?: (convId: string) => Promise<boolean>
  /** Leva a tarefa ao renderer (que cria/abre a conversa e despacha pela fila). */
  deliver: (d: McpDelivery) => void
  /** Stop da conversa pelo mesmo caminho do botão (limpa a fila dela). */
  interrupt: (convId: string) => void
  /** Tira da fila do renderer o item desta tarefa. */
  dropQueued: (convId: string, taskId: string) => void
  /** Responde a pergunta pendente pelo mesmo caminho do celular. */
  answer: (convId: string, res: PermissionResponse) => void
  newConversationId: () => string
  /** Os ids de modelo aceitos agora (os do seletor da conversa). Sem ele: só os Claude. */
  availableModels?: () => Promise<string[]>
  mkdir?: (dir: string) => Promise<void>
  fileExists?: (p: string) => Promise<boolean>
}

const ServerName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'nome de servidor MCP: letras, números, "_" e "-"')
const StdioServer = z.object({
  type: z.literal('stdio').optional(),
  command: z.string().trim().min(1).max(4096),
  args: z.array(z.string().max(8192)).max(64).optional(),
  env: z.record(z.string(), z.string().max(32_768)).optional()
})

const AbsolutePath = z
  .string()
  .trim()
  .min(1, 'projeto é obrigatório')
  .max(4096)
  .refine((p) => path.isAbsolute(p) && !/^[A-Za-z]:(?![\\/])/.test(p), 'projeto deve ser um caminho absoluto')

// Estrito: campo fora do contrato é recusado aqui também, não só pelo inputSchema.
const EnviarArgs = z.strictObject({
  prompt: z.string().min(1, 'prompt é obrigatório').max(500_000),
  cliente: z.string().trim().min(1, 'cliente é obrigatório').max(80),
  projeto: AbsolutePath,
  conversa_id: z.string().trim().min(1).max(200).optional(),
  mcp_servers: z.record(ServerName, StdioServer).optional(),
  modelo: z.string().trim().min(1, 'modelo vazio: omita o campo para usar o padrão').max(200).optional(),
  imagens: McpImagesArg.optional()
}, {
  error: (iss) => (iss.code === 'unrecognized_keys' ? `campo desconhecido: ${iss.keys.join(', ')}` : undefined)
})
const TarefaArgs = z.object({ tarefa_id: z.string().min(1).max(200) })
const ResponderArgs = z.object({
  tarefa_id: z.string().min(1).max(200),
  respostas: z.array(z.union([z.string().max(10_000), z.array(z.string().max(10_000)).max(50)])).min(1).max(20)
})

const obj = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})
const str = (description: string): Record<string, unknown> => ({ type: 'string', description })

export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'agent_code_enviar',
    description:
      'Cria uma tarefa para o agente do Agent Code e responde na hora com { tarefa_id, conversa_id } (não espera o fim). ' +
      'Acompanhe com agent_code_tarefa. ' +
      'modelo (opcional): id de um dos modelos que o GET /agent-code lista em "modelos"; sem ele, vale o "modelo_padrao". ' +
      'Modelo fora da lista é recusado com a lista dos válidos (nunca troca em silêncio); com conversa_id, vale só para esta tarefa. ' +
      `imagens (opcional): 1 a ${MCP_MAX_IMAGES} itens { nome, mime: ${MCP_IMAGE_MIMES.join(' | ')}, base64 }, até 5 MB cada depois de decodificado; ` +
      'o mime é conferido pelos bytes. Entram como anexo da mensagem, como uma imagem colada no chat. ' +
      'No prompt, [[imagem:N]] (N a partir de 1, a posição em imagens) põe a imagem N exatamente ali; ' +
      'imagem sem marcador vai no fim; marcador sem imagem é erro.',
    inputSchema: obj(
      {
        prompt: str('Instruções + pedido do usuário. Pode ter [[imagem:N]] onde cada imagem deve entrar.'),
        cliente: str('Quem envia (ex.: "Forgia"); aparece no título da conversa.'),
        projeto: str('Pasta de trabalho, caminho absoluto. Criada se não existir.'),
        conversa_id: str('Continua uma conversa anterior. Sem ele, abre conversa nova.'),
        mcp_servers: {
          type: 'object',
          description: 'Servidores MCP stdio só para esta tarefa: { "<nome>": { command, args, env } }.',
          additionalProperties: {
            type: 'object',
            properties: {
              command: { type: 'string' },
              args: { type: 'array', items: { type: 'string' } },
              env: { type: 'object', additionalProperties: { type: 'string' } }
            },
            required: ['command']
          }
        },
        modelo: str('Id do modelo para esta tarefa (um dos "modelos" do GET /agent-code). Sem ele, o "modelo_padrao".'),
        imagens: {
          type: 'array',
          description: `Até ${MCP_MAX_IMAGES} imagens (5 MB cada, decodificado). Use [[imagem:N]] no prompt para posicionar a imagem N.`,
          minItems: 1,
          maxItems: MCP_MAX_IMAGES,
          items: {
            type: 'object',
            properties: {
              nome: { type: 'string', description: 'Nome do arquivo (sem pasta).' },
              mime: { type: 'string', enum: [...MCP_IMAGE_MIMES] },
              base64: { type: 'string', description: 'Conteúdo em base64, sem o prefixo "data:".' }
            },
            required: ['nome', 'mime', 'base64'],
            additionalProperties: false
          }
        }
      },
      ['prompt', 'cliente', 'projeto']
    )
  },
  {
    name: 'agent_code_tarefa',
    description:
      'Andamento: { status: na_fila|rodando|pergunta|concluida|erro|cancelada, resposta?, erro?, pergunta? }. ' +
      'Com status "pergunta", responda com agent_code_responder.',
    inputSchema: obj({ tarefa_id: str('Id devolvido por agent_code_enviar.') }, ['tarefa_id'])
  },
  {
    name: 'agent_code_cancelar',
    description: 'Interrompe a tarefa; depois disso agent_code_tarefa responde "cancelada".',
    inputSchema: obj({ tarefa_id: str('Id da tarefa.') }, ['tarefa_id'])
  },
  {
    name: 'agent_code_responder',
    description:
      'Responde a pergunta pendente de uma tarefa em status "pergunta". respostas: uma por pergunta, na ordem; ' +
      'texto (rótulo da opção ou resposta livre) ou lista de textos quando a pergunta aceita várias.',
    inputSchema: obj(
      {
        tarefa_id: str('Id da tarefa.'),
        respostas: {
          type: 'array',
          items: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }
        }
      },
      ['tarefa_id', 'respostas']
    )
  }
]

const fail = (erro: string): McpToolResult => ({ value: { erro }, isError: true })

function issues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ')
}

/** Título da conversa nova: "<cliente> — <1ª linha do prompt>". */
export function mcpConversationTitle(cliente: string, prompt: string): string {
  const first = prompt.trim().split(/\r?\n/).find((l) => l.trim())?.replace(/^#+\s*/, '').trim() ?? ''
  const resumo = first.length > 60 ? `${first.slice(0, 60)}…` : first
  return resumo ? `${cliente} — ${resumo}` : cliente
}

/** O que agent_code_tarefa devolve (contrato: nomes em português). */
export function taskView(task: McpTask | undefined): Record<string, unknown> {
  if (!task) return { status: 'erro', erro: 'Tarefa não encontrada' }
  const out: Record<string, unknown> = { status: task.status }
  if (task.resposta !== undefined) out.resposta = task.resposta
  if (task.erro !== undefined) out.erro = task.erro
  if (task.pergunta) {
    out.pergunta = {
      perguntas: task.pergunta.perguntas.map((q) => ({
        cabecalho: q.header,
        pergunta: q.question,
        multipla: q.multiSelect,
        opcoes: q.options.map((o) => ({ rotulo: o.label, descricao: o.description }))
      })),
      ...(task.pergunta.prazo ? { prazo: new Date(task.pergunta.prazo).toISOString() } : {})
    }
  }
  return out
}

const defaultExists = (p: string): Promise<boolean> => fs.stat(p).then((s) => s.isFile(), () => false)

/**
 * O `command` existe? Caminho absoluto: o arquivo. Nome solto (`node`, `npx`):
 * procurado no PATH, com as extensões do PATHEXT no Windows — como o spawn faria.
 */
export async function commandResolvable(
  command: string,
  exists: (p: string) => Promise<boolean>,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (path.isAbsolute(command)) return exists(command)
  if (/[\\/]/.test(command)) return false // relativo com pasta: depende do cwd, não aceito
  const exts =
    platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())]
      : ['']
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      if (await exists(path.join(dir, command + ext))) return true
    }
  }
  return false
}

export function createMcpTools(deps: McpToolsDeps): McpToolsApi {
  const mkdir = deps.mkdir ?? ((d: string) => fs.mkdir(d, { recursive: true }).then(() => undefined))
  const exists = deps.fileExists ?? defaultExists
  const reserved = new Set<string>(RESERVED_MCP_SERVER_NAMES)
  const availableModels = deps.availableModels ?? (async () => selectableModelIds({ ollama: false, codex: false }))

  async function enviar(raw: unknown): Promise<McpToolResult> {
    const parsed = EnviarArgs.safeParse(raw)
    if (!parsed.success) return fail(`Parâmetros inválidos: ${issues(parsed.error)}`)
    const a = parsed.data
    const imgs = a.imagens ?? []
    for (let i = 0; i < imgs.length; i++) {
      const bad = checkImage(imgs[i], i + 1)
      if (bad) return fail(bad)
    }
    const message = buildImageMessage(a.prompt, imgs)
    if ('erro' in message) return fail(message.erro)
    // Modelo pedido: só um dos que o seletor da conversa oferece agora (conta e
    // provedores configurados). Fora da lista, erro com a lista — nunca troca.
    if (a.modelo !== undefined) {
      let modelos: string[]
      try {
        modelos = await availableModels()
      } catch (err) {
        return fail(`Não consegui conferir os modelos disponíveis: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!modelos.includes(a.modelo)) {
        return {
          value: { erro: `modelo "${a.modelo}" não está disponível no Agent Code. Modelos válidos: ${modelos.join(', ')}`, modelos },
          isError: true
        }
      }
    }
    const model = a.modelo ?? MCP_TASK_MODEL
    const servers: Record<string, McpStdioServer> = {}
    for (const [name, s] of Object.entries(a.mcp_servers ?? {})) {
      if (reserved.has(name)) return fail(`mcp_servers: o nome "${name}" é reservado pelo Agent Code`)
      // Command que não existe vira erro legível já aqui, antes de subir a sessão
      // (lá ele só falharia calado: o servidor não sobe e as ferramentas somem).
      if (!(await commandResolvable(s.command, exists))) {
        return fail(`mcp_servers.${name}: command não encontrado: ${s.command}`)
      }
      servers[name] = { command: s.command, args: s.args ?? [], env: s.env ?? {} }
    }
    // Conversa aberta por uma tarefa desta execução conta como existente: ela pode
    // ainda não ter chegado ao banco (o renderer grava com atraso).
    if (a.conversa_id && !deps.registry.configFor(a.conversa_id)) {
      let found: boolean
      try {
        found = await deps.conversationExists(a.conversa_id)
      } catch (err) {
        return fail(`Não consegui conferir a conversa (o Agent Code ainda está abrindo?): ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!found) return fail(`conversa_id não existe: ${a.conversa_id}`)
    }
    // Conversa do Agent Manager: o planejamento fixa o modelo dela e passaria
    // por cima do da tarefa (com ou sem `modelo`). Recusada como destino.
    if (a.conversa_id && deps.conversationIsPlanning) {
      let planning: boolean
      try {
        planning = await deps.conversationIsPlanning(a.conversa_id)
      } catch (err) {
        return fail(`Não consegui conferir a conversa (o Agent Code ainda está abrindo?): ${err instanceof Error ? err.message : String(err)}`)
      }
      if (planning) return fail(MCP_PLANNING_REFUSED)
    }
    try {
      await mkdir(a.projeto)
    } catch (err) {
      return fail(`Não consegui criar a pasta do projeto (${a.projeto}): ${err instanceof Error ? err.message : String(err)}`)
    }
    const convId = a.conversa_id ?? deps.newConversationId()
    const config: McpConversationConfig = { cliente: a.cliente, mcpServers: servers }
    deps.registry.setConfig(convId, config)
    // O texto da tarefa é o que o `agent:send` vai levar (com `{{midia:N}}`): é
    // por ele que o registro reconhece o início dela.
    const task = deps.registry.create(convId, message.text, a.modelo)
    deps.deliver({
      taskId: task.id,
      convId,
      text: message.text,
      model,
      ...(message.images.length ? { images: message.images } : {}),
      ...(a.conversa_id
        ? {}
        : { create: { cwd: a.projeto, title: mcpConversationTitle(a.cliente, readableMediaText(message.text)) } })
    })
    return { value: { tarefa_id: task.id, conversa_id: convId } }
  }

  function tarefa(raw: unknown): McpToolResult {
    const parsed = TarefaArgs.safeParse(raw)
    if (!parsed.success) return fail(`Parâmetros inválidos: ${issues(parsed.error)}`)
    return { value: taskView(deps.registry.get(parsed.data.tarefa_id)) }
  }

  function cancelar(raw: unknown): McpToolResult {
    const parsed = TarefaArgs.safeParse(raw)
    if (!parsed.success) return fail(`Parâmetros inválidos: ${issues(parsed.error)}`)
    const task = deps.registry.get(parsed.data.tarefa_id)
    if (!task) return { value: taskView(undefined) }
    const action = deps.registry.cancel(task.id)
    if (action === 'drop-queued') deps.dropQueued(task.convId, task.id)
    else if (action === 'interrupt') {
      // O renderer faz o Stop do jeito do botão (limpa a fila da conversa e avisa
      // cada tarefa que estava nela); aqui já vale como cancelada.
      deps.registry.onInterrupt(task.convId)
      deps.interrupt(task.convId)
    }
    return { value: taskView(task) }
  }

  function responder(raw: unknown): McpToolResult {
    const parsed = ResponderArgs.safeParse(raw)
    if (!parsed.success) return fail(`Parâmetros inválidos: ${issues(parsed.error)}`)
    const task = deps.registry.get(parsed.data.tarefa_id)
    if (!task) return { value: taskView(undefined) }
    const q = task.pergunta
    if (task.status !== 'pergunta' || !q) return fail(`A tarefa não está esperando resposta (status: ${task.status})`)
    const { respostas } = parsed.data
    if (respostas.length !== q.perguntas.length) {
      return fail(`São ${q.perguntas.length} pergunta(s); vieram ${respostas.length} resposta(s)`)
    }
    const answers = q.perguntas.map((p, i) => {
      const r = respostas[i]
      const selected = (Array.isArray(r) ? r : [r]).map((s) => s.trim()).filter(Boolean)
      return { header: p.header, question: p.question, selected }
    })
    if (answers.some((x) => x.selected.length === 0)) return fail('Toda pergunta precisa de uma resposta')
    deps.answer(task.convId, { id: q.id, behavior: 'allow', answers })
    deps.registry.onQuestionClosed(task.convId, q.id)
    return { value: taskView(task) }
  }

  return {
    list: () => MCP_TOOL_DEFINITIONS,
    async call(name, args) {
      switch (name) {
        case 'agent_code_enviar':
          return enviar(args)
        case 'agent_code_tarefa':
          return tarefa(args)
        case 'agent_code_cancelar':
          return cancelar(args)
        case 'agent_code_responder':
          return responder(args)
        default:
          return null
      }
    }
  }
}
