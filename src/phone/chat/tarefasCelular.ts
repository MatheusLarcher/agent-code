/**
 * As tarefas agendadas no celular: a lista vem do `/api/state` (o PC é a fonte da
 * verdade); o aviso `tarefasChanged` do SSE adianta a troca, e as ações
 * (pausar/retomar/cancelar/visto) vão pelo POST /api/ipc, no mesmo handler da tela do PC.
 */
import { useEffect, useMemo } from 'react'
import { Channels } from '@shared/ipc'
import { resumosPorConversa, type TarefaAcao, type TarefaVista, type Validado } from '@shared/tarefas'
import { client } from '../app/runtime'
import { useStore } from '../core/store'
import { invokeIpc, onIpcEvent } from '../office/bridgeApi'

let ligado = false

/** O aviso ao vivo do PC troca a lista na hora (sem esperar o próximo /api/state). */
function ligarAvisos(): void {
  if (ligado) return
  ligado = true
  onIpcEvent<TarefaVista[]>(client, Channels.tarefasChanged, (vistas) => {
    if (Array.isArray(vistas)) client.store.set({ tarefas: vistas })
  })
}

function useTodas(): TarefaVista[] {
  useEffect(ligarAvisos, [])
  return useStore(client.store, (s) => s.tarefas)
}

export function useTarefasDaConversaCelular(convId: string | null): TarefaVista[] {
  const todas = useTodas()
  return useMemo(() => (convId ? todas.filter((t) => t.convId === convId) : []), [todas, convId])
}

export function useResumosCelular(): ReturnType<typeof resumosPorConversa> {
  const todas = useTodas()
  return useMemo(() => resumosPorConversa(todas), [todas])
}

/** A ação no PC; depois, o estado novo (a resposta do PC já reflete a mudança). */
export async function acaoNoCelular(id: string, acao: TarefaAcao): Promise<Validado<TarefaVista | null>> {
  const r = await invokeIpc<Validado<TarefaVista | null>>(client, Channels.tarefasAcao, [{ id, acao }])
  void client.fetchState().catch(() => undefined)
  return r
}
