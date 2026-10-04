/**
 * O painel de Memórias do Escritório (req-painel-memorias) — SÓ LEITURA: a lista
 * das memórias e o texto de uma. Gravar, editar e aposentar continuam só pelo
 * memory_propose dos agentes. O corpo vem como está no banco: os segredos já
 * são a marca `{{secret:…}}` (o valor do cofre nunca vem).
 */

/** Uma memória na lista (sem o corpo). */
export interface MemoryListItem {
  relPath: string
  title: string
  /** O gancho (a linha do MEMORY.md). */
  hook: string
  /** A pasta (dirname do relPath; '' na raiz). */
  folder: string
  /** O alcance da memória: usuário, projeto ou domínio (o "tipo" no painel). */
  scope: 'user' | 'project' | 'domain'
  projectCwd: string | null
  revision: number
  status: 'active' | 'retired'
  updatedAt: string
}

/** O texto de uma memória (markdown, só leitura). */
export interface MemoryReadResult {
  relPath: string
  body: string
}

/** Marca de segredo no corpo (o painel nunca mostra valor). */
export const SECRET_MARKER = /\{\{secret:[^}]+\}\}/g
