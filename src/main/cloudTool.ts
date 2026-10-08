import { z } from 'zod'
import type { CloudInspectionDto, CloudSwitchAction, CloudSwitchRequestDto } from '../shared/databaseBackup'
import type { PostgresConnectionDraft } from '../shared/ipc'

/**
 * A ferramenta `app_postgres_nuvem` do servidor MCP `app`: o agente liga, desliga
 * ou testa o PostgreSQL da nuvem por comando direto, pelo MESMO caminho da tela
 * (backup/cloudSwitch.ts). `manter` é obrigatório e sem padrão: o `testar` devolve
 * o que cada lado tem para o agente mostrar e perguntar — ele nunca escolhe. A
 * troca roda depois do turno de quem chamou (a guarda do app_restart).
 */

export const CLOUD_TOOL_NAME = 'app_postgres_nuvem'

export const CLOUD_TOOL_DESCRIPTION =
  "Turn Agent Code's optional cloud PostgreSQL on or off, or test it. ALWAYS call acao='testar' first: it returns what each side " +
  '(this PC = local, cloud = nuvem) has — conversations and last update — and what each choice does. Show that to the user and ASK ' +
  "which side to keep; NEVER choose 'manter' yourself. 'manter' is required for ligar/desligar and has no default. Prefer the vault " +
  "placeholder {{secret:name}} in 'senha'; if the user typed the password in the chat, warn once that it stays in the conversation " +
  'history and was sent to the model provider, then go on. ligar/desligar is refused while another conversation is mid-turn; when ' +
  'accepted, the switch (with a backup of the side being overwritten) starts after THIS turn ends and the app restarts — finish your turn.'

export const cloudToolSchema = {
  acao: z.enum(['testar', 'ligar', 'desligar']).describe("'testar' first; 'ligar'/'desligar' only after the user chose the side to keep."),
  host: z.string().trim().min(1).max(255).optional().describe('Cloud server host (omit to use the one saved in this app).'),
  porta: z.number().int().min(1).max(65_535).optional(),
  usuario: z.string().trim().min(1).max(128).optional(),
  senha: z.string().max(10_000).optional().describe('Password, preferably {{secret:name}} from the vault. Omit to keep the saved one.'),
  banco_manutencao: z.string().trim().min(1).max(128).optional().describe("Maintenance database (default 'postgres')."),
  tls: z.enum(['disable', 'prefer', 'require', 'verify-full']).optional().describe('TLS mode, accepted as the user configures it.'),
  ca: z.string().max(1_000_000).optional().describe('CA PEM, only for verify-full.'),
  manter: z
    .enum(['local', 'nuvem'])
    .optional()
    .describe("REQUIRED for ligar/desligar, no default: the side the USER chose to keep ('local' = this PC, 'nuvem' = cloud).")
}

const inputSchema = z.object(cloudToolSchema).strict()
export type CloudToolInput = z.infer<typeof inputSchema>

export interface CloudToolReply {
  ok: boolean
  text: string
}

export interface CloudToolDeps {
  /** O lado em uso e a conexão salva da nuvem (sem a senha). */
  current(): Promise<{ target: 'local' | 'cloud'; saved: Omit<PostgresConnectionDraft, 'password'> }>
  /** Valor de um segredo do cofre; resolvido no main, nunca volta ao modelo. */
  readSecret(name: string): Promise<string | null>
  inspect(action: CloudSwitchAction, draft?: PostgresConnectionDraft): Promise<CloudInspectionDto>
  /** Testa a conexão com a nuvem (sem rascunho = a salva, com a senha salva). */
  testConnection(draft?: PostgresConnectionDraft): Promise<void>
  /** A troca agendada: roda quando nenhuma conversa estiver no meio de um turno. */
  schedule(request: CloudSwitchRequestDto): void
  /** Os OUTROS turnos agora (o de quem chamou está em andamento por definição). */
  othersIdle(): { ok: boolean; message: string }
}

const SECRET = /^\{\{secret:([^{}]+)\}\}$/

interface ResolvedDraft {
  draft?: PostgresConnectionDraft
  plainPassword: boolean
  error?: string
}

async function resolveDraft(input: CloudToolInput, deps: CloudToolDeps): Promise<ResolvedDraft> {
  const touched = ['host', 'porta', 'usuario', 'senha', 'banco_manutencao', 'tls', 'ca'].some(
    (key) => input[key as keyof CloudToolInput] !== undefined
  )
  if (!touched) return { plainPassword: false }
  let password = ''
  let plainPassword = false
  if (input.senha !== undefined) {
    const secret = SECRET.exec(input.senha.trim())
    if (secret) {
      const value = await deps.readSecret(secret[1].trim())
      if (value === null) return { plainPassword: false, error: `Não há segredo chamado "${secret[1].trim()}" no cofre.` }
      password = value
    } else {
      password = input.senha
      plainPassword = input.senha.length > 0
    }
  }
  const { saved } = await deps.current()
  return {
    plainPassword,
    draft: {
      host: input.host ?? saved.host,
      port: input.porta ?? saved.port,
      user: input.usuario ?? saved.user,
      password,
      maintenanceDatabase: input.banco_manutencao ?? saved.maintenanceDatabase,
      tlsMode: input.tls ?? saved.tlsMode,
      ca: input.ca ?? saved.ca
    }
  }
}

const PLAIN_PASSWORD_WARNING =
  'Aviso (diga ao usuário uma vez): a senha veio em texto puro no chat — ela fica no histórico desta conversa e foi enviada ao ' +
  'provedor do modelo. Da próxima vez, guarde-a no cofre e use {{secret:nome}}.'

function describeSide(label: string, side: CloudInspectionDto['local']): string {
  if (!side.reachable) return `${label}: sem conexão (${side.error ?? 'erro desconhecido'})`
  if (!side.exists) return `${label}: conectou (PostgreSQL ${side.serverVersion ?? '?'}), banco agent-code ainda não existe (vazio)`
  return `${label}: ${side.conversations} conversa(s), última atualização ${side.lastUpdate ?? 'nenhuma'} (PostgreSQL ${side.serverVersion ?? '?'})`
}

export function formatInspection(inspection: CloudInspectionDto): string {
  const lines = [
    `Ação possível agora: ${inspection.action === 'ligar' ? 'LIGAR a nuvem' : 'DESLIGAR a nuvem'}.`,
    describeSide('Local (este PC)', inspection.local),
    describeSide('Nuvem', inspection.cloud),
    'O que cada escolha faz:',
    ...inspection.options.map((option) => `- manter='${option.keep}': ${option.description}`)
  ]
  if (inspection.suggested) lines.push(`O outro lado está vazio: o natural é manter='${inspection.suggested}' (confirme com o usuário).`)
  if (inspection.otherInstallations.length) {
    lines.push(
      `ATENÇÃO: a nuvem foi usada por outro(s) PC(s) nos últimos dias (último: ${inspection.otherInstallations[0].lastSeenAt}). ` +
        "Ligar mantendo 'local' sobrescreve o que esse outro PC usa."
    )
  }
  if (inspection.olderCloudServer) {
    lines.push('ATENÇÃO: a nuvem roda um PostgreSQL mais antigo que o 18 do app; copiar o local para ela pode falhar (e aí nada muda).')
  }
  lines.push('Mostre isto ao usuário e PERGUNTE qual lado manter. Não escolha sozinho.')
  return lines.join('\n')
}

export async function runCloudTool(raw: unknown, deps: CloudToolDeps): Promise<CloudToolReply> {
  const parsed = inputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, text: `Parâmetros inválidos: ${parsed.error.issues.map((issue) => issue.message).join('; ')}` }
  const input = parsed.data
  try {
    const resolved = await resolveDraft(input, deps)
    if (resolved.error) return { ok: false, text: resolved.error }
    const warning = resolved.plainPassword ? `\n\n${PLAIN_PASSWORD_WARNING}` : ''
    const { target } = await deps.current()
    const possible: CloudSwitchAction = target === 'cloud' ? 'desligar' : 'ligar'
    if (input.acao === 'testar') {
      return { ok: true, text: formatInspection(await deps.inspect(possible, resolved.draft)) + warning }
    }
    if (!input.manter) {
      return {
        ok: false,
        text: "'manter' é obrigatório em ligar/desligar e não tem padrão: mostre o resultado do 'testar' ao usuário, pergunte qual lado manter (local ou nuvem) e chame de novo."
      }
    }
    if (input.acao !== possible) {
      return { ok: false, text: possible === 'desligar' ? 'A nuvem já está ligada: a ação possível é desligar.' : 'A nuvem já está desligada: a ação possível é ligar.' }
    }
    const guard = deps.othersIdle()
    if (!guard.ok) return { ok: false, text: `Troca recusada: ${guard.message} Tente quando as outras conversas terminarem o turno.` }
    // Precisa da nuvem (ligar, ou desligar trazendo os dados dela): conexão ruim falha já, não depois do turno.
    if (input.acao === 'ligar' || input.manter === 'nuvem') await deps.testConnection(resolved.draft)
    deps.schedule({ action: input.acao, keep: input.manter, ...(resolved.draft ? { draft: resolved.draft } : {}) })
    return {
      ok: true,
      text:
        `Troca preparada (${input.acao === 'ligar' ? 'ligar' : 'desligar'} a nuvem, mantendo os dados ${input.manter === 'local' ? 'locais' : 'da nuvem'}). ` +
        'Ela começa quando este turno terminar e nenhuma outra conversa estiver no meio de um turno; antes de sobrescrever um lado, o app faz ' +
        'backup dele, e ao terminar o app reinicia. O resultado aparece no topo do app e em Configurações → Dados. Termine o turno agora.' +
        warning
    }
  } catch (error) {
    return { ok: false, text: `Falhou: ${error instanceof Error ? error.message : String(error)}` }
  }
}

// O main configura uma vez (index.ts); a sessão usa por aqui.
let configured: Omit<CloudToolDeps, 'othersIdle'> | null = null

export function configureCloudTool(deps: Omit<CloudToolDeps, 'othersIdle'> | null): void {
  configured = deps
}

export function cloudToolDeps(othersIdle: CloudToolDeps['othersIdle']): CloudToolDeps | null {
  return configured ? { ...configured, othersIdle } : null
}
