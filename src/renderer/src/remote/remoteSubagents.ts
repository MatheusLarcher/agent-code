/**
 * Os subagentes rodando de uma conversa, no formato leve que o celular recebe
 * (`RemoteConversation.subagents`): papel, resumo do SDK e início. A ferramenta
 * da vez fica de fora de propósito — ela muda a cada chamada e faria a ponte
 * republicar sem parar; a chave do diff só muda quando entra/sai subagente ou
 * quando o resumo muda.
 */
import type { RemoteSubagent } from '@shared/ipc'
import type { TrackMap } from '../agentTracks'
import { roleFromSubagentType, type CrewRole } from '../crew'

/** O papel como o celular escreve (o cartão do PC usa o id curto). */
const ROLE_LABEL: Partial<Record<CrewRole, string>> = {
  executor: 'Executor',
  critico: 'Crítico',
  'navegador-de-codigo': 'Navegador de código',
  memoria: 'Memória'
}

/** Os rodando, do mais antigo ao mais novo (a faixa não reordena quando um entra); undefined sem nenhum. */
export function remoteSubagents(tracks: TrackMap | undefined): RemoteSubagent[] | undefined {
  if (!tracks) return undefined
  const running = Object.values(tracks)
    .filter((track) => track.status === 'running')
    .sort((a, b) => a.startedAt - b.startedAt)
  if (running.length === 0) return undefined
  return running.map((track) => {
    const summary = track.task?.summary?.trim()
    return {
      id: track.id,
      label: ROLE_LABEL[roleFromSubagentType(track.subagentType)] ?? track.label,
      ...(summary ? { summary } : {}),
      startedAt: track.startedAt
    }
  })
}

/** A chave do diff da ponte: ids, rótulos e resumos — nunca a ferramenta da vez. */
export function remoteSubagentsKey(list: readonly RemoteSubagent[] | undefined): string {
  return (list ?? []).map((s) => `${s.id}\u0000${s.label}\u0000${s.summary ?? ''}`).join('\u0001')
}
