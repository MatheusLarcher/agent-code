import { resolveProjectIdentity } from '../persistence/projectIdentity'
import type { TaskLedger } from './taskLedger'

/** Só o que esta resolução usa do registro — assim um chamador com um recorte
 *  do ledger (como o servidor MCP) serve sem cast. */
export type ProjectIdentityStore = Pick<TaskLedger, 'recordProjectIdentity' | 'projectCwdsForIdentity'>

/**
 * "Que caminhos são o MESMO projeto que este?"
 *
 * `tasks.project_cwd` é o caminho local, então o mesmo repositório clonado em
 * `C:\GitHub\agent-code` e `D:\dev\agent-code` parecia dois projetos no
 * PostgreSQL compartilhado: cada PC só enxergava a própria fila, e uma tarefa
 * deixada por um nunca era reivindicada pelo outro.
 *
 * A identidade estável já existia para as conversas (`resolveProjectIdentity`:
 * remote do git normalizado + commit raiz, com a pasta como último recurso).
 * O que faltava era o registro de tarefas usá-la. Aqui cada PC **grava a
 * própria linha** (caminho dele → id) e **lê os irmãos** (todos os caminhos sob
 * o mesmo id) — nenhuma máquina precisa saber o caminho da outra de antemão.
 */

interface Entry {
  cwds: string[]
  at: number
}

/**
 * O git é processo externo (~dezenas de ms) e o painel consulta em poll. O TTL
 * é curto porque a lista só cresce quando OUTRO PC aparece — esperar um minuto
 * por isso é aceitável; pagar `git rev-list` a cada 6 segundos, não.
 */
export const PROJECT_SCOPE_TTL_MS = 60_000

const cache = new Map<string, Entry>()

/** Só para teste: esquece o que já foi resolvido. */
export function clearProjectScopeCache(): void {
  cache.clear()
}

/**
 * Os caminhos equivalentes a `projectCwd`, incluindo ele. Nunca lança: se a
 * identidade não resolve (pasta que sumiu, git ausente, banco fora do ar), cai
 * no comportamento de sempre — só o caminho local. Degradar para "vejo menos"
 * é o lado certo de errar; o contrário (devolver fila de outro projeto) seria
 * exatamente o bug que o filtro por projeto existe para impedir.
 */
export async function resolveProjectCwds(
  ledger: ProjectIdentityStore | null,
  projectCwd: string,
  now = Date.now()
): Promise<string[]> {
  if (!projectCwd) return []
  if (!ledger) return [projectCwd]

  const cached = cache.get(projectCwd)
  if (cached && now - cached.at < PROJECT_SCOPE_TTL_MS) return cached.cwds

  let cwds = [projectCwd]
  try {
    const identity = await resolveProjectIdentity(projectCwd)
    await ledger.recordProjectIdentity({
      projectCwd,
      projectId: identity.projectId,
      signature: identity.signature
    })
    const siblings = await ledger.projectCwdsForIdentity(identity.projectId)
    // O próprio caminho entra mesmo que a gravação acima não tenha aparecido
    // ainda na leitura — não existe cenário em que ele não pertence à lista.
    cwds = [...new Set([projectCwd, ...siblings])]
  } catch {
    /* sem identidade: segue valendo só o caminho local */
  }
  cache.set(projectCwd, { cwds, at: now })
  return cwds
}
