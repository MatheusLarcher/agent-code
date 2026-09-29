/**
 * Regras do modo sandbox no renderer, fora do App.tsx para serem testáveis
 * sem montar a janela.
 *
 * O sandbox é um projeto VIRTUAL identificado pelo caminho: toda conversa com
 * `cwd` dentro da raiz (`<localDir>\sandbox`, vinda do main) é do sandbox.
 * Cada conversa tem a sua subpasta; a barra lateral as junta num projeto fixo
 * "Sandbox", sempre no topo.
 */
import { isBlankConversation } from '../blankConversation'
import type { Conversation } from '../types'

export const SANDBOX_PROJECT_NAME = 'Sandbox'

/** Normaliza para comparar: barras unificadas, `.`/`..` resolvidos, sem barra
 *  final e sem diferenciar maiúsculas (o sandbox só existe no Windows local). */
function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\//g, '\\').split('\\')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part.toLowerCase())
  }
  return out.join('\\')
}

/** `cwd` está DENTRO da raiz do sandbox (a raiz em si não conta). */
export function isSandboxCwd(root: string, cwd: string | undefined): boolean {
  if (!root || !cwd) return false
  const r = normalize(root)
  const c = normalize(cwd)
  return c.length > r.length && c.startsWith(`${r}\\`)
}

/** Sem nenhuma conversa depois de carregar (primeiro uso, ou todas apagadas)
 *  → o app já abre numa conversa de sandbox, sem seletor de pasta. */
export function shouldOpenSandboxOnBoot(conversations: readonly Conversation[]): boolean {
  return conversations.length === 0
}

/** Para onde vai o "Nova conversa": sandbox quando não há conversa ativa com
 *  pasta ou quando a ativa é de sandbox; senão, a pasta da ativa. */
export function newChatTarget(
  active: Conversation | null | undefined,
  sandboxRoot: string
): 'sandbox' | { folder: string } {
  if (!active?.cwd || isSandboxCwd(sandboxRoot, active.cwd)) return 'sandbox'
  return { folder: active.cwd }
}

/** A conversa de sandbox vazia para reaproveitar (qualquer subpasta): a ativa
 *  se for uma delas, senão a primeira. Nenhuma → undefined (subpasta nova). */
export function findBlankSandboxConversation(
  list: readonly Conversation[],
  sandboxRoot: string,
  preferId?: string | null
): Conversation | undefined {
  const blanks = list.filter((c) => isSandboxCwd(sandboxRoot, c.cwd) && isBlankConversation(c))
  return blanks.find((c) => c.id === preferId) ?? blanks[0]
}

/** O mínimo de um projeto da barra lateral que o agrupamento precisa. */
export interface GroupableProject {
  path: string
  name: string
  conversations: Conversation[]
  total?: number
  hasMore?: boolean
  loadingMore?: boolean
  sandbox?: boolean
}

/** Tira as subpastas do sandbox do agrupamento por pasta e as junta no
 *  projeto fixo "Sandbox", sempre no topo, mesmo vazio. Sem raiz conhecida
 *  (o main ainda não respondeu) a lista fica como está. */
export function groupSidebarProjects<P extends GroupableProject>(
  projects: readonly P[],
  sandboxRoot: string
): Array<P | (GroupableProject & { sandbox: true })> {
  if (!sandboxRoot) return [...projects]
  const inside = projects.filter((p) => isSandboxCwd(sandboxRoot, p.path))
  const rest = projects.filter((p) => !isSandboxCwd(sandboxRoot, p.path) && normalize(p.path) !== normalize(sandboxRoot))
  const conversations = inside.flatMap((p) => p.conversations).sort((a, b) => b.updatedAt - a.updatedAt)
  const total = inside.reduce((sum, p) => sum + Math.max(p.total ?? 0, p.conversations.length), 0)
  const sandbox: GroupableProject & { sandbox: true } = {
    path: sandboxRoot,
    name: SANDBOX_PROJECT_NAME,
    conversations,
    total,
    // Cada subpasta tem uma conversa: "mostrar mais" por subpasta não faz sentido.
    hasMore: false,
    loadingMore: inside.some((p) => p.loadingMore),
    sandbox: true
  }
  return [sandbox, ...rest]
}
