import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { StorageError, type MemoryEntry } from '../persistence/types'
import type { MemoryProposeInput } from './memoryModel'
import type { MemoryService } from './memoryService'
import { sanitizeProposal } from './memorySecrets'
import type { SecretSink } from './memorySecrets'

/**
 * The single supported way for the model to write memories: `Write`/`Edit` on the
 * memories folder bypass the proposal queue, the CAS and the secret scan, so the
 * agent gets these tools instead. Every handler answers with text — a failure is a
 * readable pt-BR sentence, never a stack trace, because the model has to act on it.
 */

type Text = { content: { type: 'text'; text: string }[] }
const text = (t: string): Text => ({ content: [{ type: 'text', text: t }] })

const LIST_DEFAULT_LIMIT = 30
const LIST_MAX_LIMIT = 100
/** Bounded lookup window for the just-enqueued proposal after applyPending(). */
const PROPOSAL_LOOKUP_LIMIT = 200

export interface MemoryToolDeps {
  service: Pick<MemoryService, 'propose' | 'listEntries' | 'listProposals' | 'applyPending' | 'memoriesDir'>
  /** null when the vault is unavailable on this device. */
  vault: SecretSink | null
  /** Injected for tests; defaults to sanitizeProposal from './memorySecrets'. */
  sanitize?: typeof sanitizeProposal
  /** Live read of AppConfig.secretVaultEnabled; checked per call, never cached. */
  secretVaultEnabled: () => boolean
  /** Reads the plaintext for memory_secret_get. null when unavailable. */
  readSecret: ((name: string) => Promise<string | null>) | null
  conversationId: string
  agent: string
}

function describeError(error: unknown): string {
  if (error instanceof StorageError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

/** Keeps a tool failure inside the conversation: the model can fix its input. */
async function guard(label: string, work: () => Promise<Text>): Promise<Text> {
  try {
    return await work()
  } catch (error) {
    return text(`${label} falhou: ${describeError(error)}`)
  }
}

function matches(entry: MemoryEntry, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [entry.relPath, entry.title, entry.hook].some((field) => field.toLowerCase().includes(needle))
}

function entryLine(entry: MemoryEntry): string {
  return `- ${entry.relPath} (revisão ${entry.revision}) — ${entry.title}${entry.hook ? `: ${entry.hook}` : ''}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- how the SDK itself types a tool list.
type AnyTool = SdkMcpToolDefinition<any>
/** `SdkMcpToolDefinition<any>` widens the handler args to an index signature, so
 *  a concretely-typed tool is not assignable to it without erasing the shape. */
const erase = (definition: unknown): AnyTool => definition as AnyTool

export function buildMemoryTools(deps: MemoryToolDeps): AnyTool[] {
  const sanitize = deps.sanitize ?? sanitizeProposal
  const tools: AnyTool[] = [
    erase(tool(
      'memory_propose',
      'Grave uma memória de longo prazo (criar, atualizar ou aposentar). Esta é a ÚNICA forma suportada de escrever na pasta de memórias — nunca use Write/Edit lá. Para atualizar, primeiro rode memory_list e informe expected_revision com a revisão atual.',
      {
        op: z.enum(['create', 'update', 'retire']).describe('create = arquivo novo; update = substituir o corpo; retire = aposentar.'),
        rel_path: z.string().describe('Caminho relativo à pasta de memórias, terminando em .md (ex.: projeto/decisoes-de-build.md). Em create precisa ser slug kebab-case.'),
        title: z.string().optional().describe('Título curto da memória (obrigatório em create).'),
        hook: z.string().optional().describe('Uma linha para o índice explicando quando esta memória importa (obrigatório em create).'),
        body: z.string().optional().describe('Conteúdo Markdown completo do arquivo (obrigatório em create/update).'),
        scope: z.enum(['user', 'project', 'domain']).optional().describe('Alcance da memória (padrão "user").'),
        project_cwd: z.string().optional().describe('Pasta do projeto quando scope = "project".'),
        domain: z.string().optional().describe('Domínio quando scope = "domain".'),
        expected_revision: z.number().int().positive().optional().describe('Revisão atual da entrada; obrigatório em update. Vem do memory_list.'),
        secrets: z
          .array(z.object({ name: z.string(), value: z.string() }))
          .optional()
          .describe('Valores sensíveis que devem ir para o cofre e virar {{secret:nome}} no texto.')
      },
      async (a) =>
        guard('memory_propose', async () => {
          const input: MemoryProposeInput = {
            op: a.op,
            relPath: a.rel_path,
            title: a.title ?? null,
            hook: a.hook ?? null,
            body: a.body ?? null,
            scope: a.scope,
            projectCwd: a.project_cwd ?? null,
            domain: a.domain ?? null,
            proposedBy: `session:${deps.conversationId}`,
            expectedRevision: a.expected_revision ?? null,
            originConversationId: deps.conversationId,
            originAgent: deps.agent
          }
          const sanitized = await sanitize(input, { vault: deps.vault, explicit: a.secrets })
          const proposal = await deps.service.propose(sanitized.input)
          const summary = await deps.service.applyPending()
          const lines: string[] = []
          const settled = (await deps.service.listProposals({ limit: PROPOSAL_LOOKUP_LIMIT })).find((item) => item.id === proposal.id)
          const status = settled?.status ?? (summary.applied > 0 ? 'applied' : 'pending')
          if (status === 'applied') {
            lines.push(`Memória aplicada: ${proposal.relPath}.`)
          } else if (status === 'conflict' || status === 'rejected') {
            const current = (await deps.service.listEntries({ status: 'active' })).find((entry) => entry.relPath === proposal.relPath)
            lines.push(`Conflito em ${proposal.relPath}: ${settled?.reason ?? 'motivo não registrado'}.`)
            lines.push(
              current
                ? `Revisão atual: ${current.revision}. Refaça a proposta com expected_revision = ${current.revision}.`
                : 'Não há entrada ativa nesse caminho hoje.'
            )
          } else {
            lines.push(`Memória enfileirada (pendente) em ${proposal.relPath}; use memory_status para acompanhar.`)
          }
          // Nunca ecoe o valor: só o nome no cofre e o motivo de cada pulo.
          if (sanitized.stored.length) lines.push(`Segredos guardados no cofre: ${sanitized.stored.join(', ')}.`)
          if (sanitized.skipped.length) {
            lines.push(`Valores sensíveis NÃO guardados (cofre indisponível): ${sanitized.skipped.map((match) => match.kind).join(', ')}.`)
          }
          for (const note of sanitized.notes) lines.push(note)
          for (const conflict of summary.projectionConflicts) lines.push(`Projeção: ${conflict.relPath} — ${conflict.reason}`)
          return text(lines.join('\n'))
        })
    )),
    erase(tool(
      'memory_list',
      'Lista as memórias ativas com caminho, título, gancho e a REVISÃO ATUAL (necessária para memory_propose com op="update").',
      {
        query: z.string().optional().describe('Filtro por texto em caminho, título ou gancho.'),
        limit: z.number().int().positive().optional().describe(`Máximo de itens (padrão ${LIST_DEFAULT_LIMIT}, teto ${LIST_MAX_LIMIT}).`)
      },
      async (a) =>
        guard('memory_list', async () => {
          const limit = Math.min(a.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT)
          const all = (await deps.service.listEntries({ status: 'active' })).filter((entry) => matches(entry, a.query ?? ''))
          if (!all.length) return text('Nenhuma memória ativa.')
          const shown = all.slice(0, limit)
          const lines = shown.map(entryLine)
          if (all.length > shown.length) {
            lines.push(`… ${all.length - shown.length} de ${all.length} memórias omitidas; refine com "query" ou aumente "limit".`)
          }
          return text(lines.join('\n'))
        })
    )),
    erase(tool(
      'memory_status',
      'Mostra as propostas de memória pendentes e em conflito, com o motivo — use quando uma gravação não aparecer.',
      {},
      async () =>
        guard('memory_status', async () => {
          const proposals = await deps.service.listProposals({ status: ['pending', 'conflict'], limit: PROPOSAL_LOOKUP_LIMIT })
          if (!proposals.length) return text('Nenhuma proposta pendente ou em conflito.')
          return text(
            proposals
              .map((item) => `- [${item.status}] ${item.op} ${item.relPath}${item.reason ? ` — ${item.reason}` : ''}`)
              .join('\n')
          )
        })
    ))
  ]

  // Registrado só quando o cofre está ligado na criação da sessão; o handler
  // reconfere a cada chamada para que desligar a opção corte o acesso na hora.
  if (deps.secretVaultEnabled()) {
    tools.push(
      erase(tool(
        'memory_secret_get',
        'Lê o valor real de um segredo guardado no cofre (os placeholders {{secret:nome}} das memórias). Use apenas quando precisar do valor para executar a tarefa.',
        { name: z.string().describe('Nome do segredo, como aparece em {{secret:nome}}.') },
        async ({ name }) =>
          guard('memory_secret_get', async () => {
            if (!deps.secretVaultEnabled()) return text('O cofre de segredos está desligado nas configurações; peça o valor ao usuário.')
            if (!deps.readSecret) return text('O cofre de segredos não está disponível neste dispositivo.')
            const value = await deps.readSecret(name)
            if (value === null) return text(`Não há segredo chamado "${name}" no cofre.`)
            return text(value)
          })
      ))
    )
  }
  return tools
}

export function createMemoryMcpServer(deps: MemoryToolDeps): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({ name: 'memory', version: '1.0.0', tools: buildMemoryTools(deps) })
}
