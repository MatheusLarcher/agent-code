import { useMemo, useSyncExternalStore } from 'react'
import { resumosPorConversa, type TarefaAcao, type TarefaResumoConversa, type TarefaVista, type Validado } from '@shared/tarefas'

/**
 * As tarefas agendadas na tela do PC. O main é a fonte da verdade: a lista vem do
 * `tarefasList` e é trocada inteira a cada `tarefasChanged`. Uma assinatura só para
 * o app inteiro (a bolinha de cada chat e o selo da barra leem daqui).
 */

const VAZIA: TarefaVista[] = []
let lista: TarefaVista[] = VAZIA
let ligado = false
const ouvintes = new Set<() => void>()

function trocar(nova: unknown): void {
  const proxima = Array.isArray(nova) ? (nova as TarefaVista[]) : VAZIA
  if (proxima === lista) return
  lista = proxima
  for (const fn of ouvintes) fn()
}

function ligar(): void {
  if (ligado || typeof window === 'undefined' || !window.api?.tarefasList) return
  ligado = true
  window.api.onTarefasChanged?.((vistas) => trocar(vistas))
  window.api.tarefasList().then(trocar, () => undefined)
}

function assinar(fn: () => void): () => void {
  ligar()
  ouvintes.add(fn)
  return () => ouvintes.delete(fn)
}

export function useTarefas(): TarefaVista[] {
  return useSyncExternalStore(assinar, () => lista)
}

/** As tarefas visíveis de uma conversa (a bolinha). */
export function useTarefasDaConversa(convId: string | null | undefined): TarefaVista[] {
  const todas = useTarefas()
  return useMemo(() => (convId ? todas.filter((t) => t.convId === convId) : VAZIA), [todas, convId])
}

/** convId → resumo, para o selo da lista de conversas. */
export function useResumosDeTarefas(): ReadonlyMap<string, TarefaResumoConversa> {
  const todas = useTarefas()
  return useMemo(() => resumosPorConversa(todas), [todas])
}

/** A ação pelo IPC; a lista nova chega pelo `tarefasChanged`. */
export function acaoNoPc(id: string, acao: TarefaAcao): Promise<Validado<TarefaVista | null>> {
  if (!window.api?.tarefasAcao) return Promise.resolve({ ok: false, erro: 'tarefas indisponíveis nesta versão' })
  return window.api.tarefasAcao({ id, acao })
}

/** Só para os testes: zera a assinatura do módulo. */
export function _resetTarefasParaTeste(): void {
  lista = VAZIA
  ligado = false
  ouvintes.clear()
}
