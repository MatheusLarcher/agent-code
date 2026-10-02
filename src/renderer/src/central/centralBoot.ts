/**
 * Boot da Central: depois da hidratação, garante que ela está na tela.
 *
 * - Já carregada (era a conversa ativa da sessão anterior): nada a fazer.
 * - No banco: lida por id — conversa sem pasta não entra na carga por projeto.
 * - Em lugar nenhum: criada ao fundo, com o id fixo (há UMA Central, sempre).
 *
 * Nunca a torna ativa: só abre nela quem a deixou aberta (isso é do boot do App).
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import { CENTRAL_ID } from '@shared/central'
import type { Conversation } from '../types'

export interface CentralBootDeps {
  /** As conversas na tela (a ref do App: o estado só chega a ela no próximo render). */
  convsRef: MutableRefObject<Conversation[]>
  /** Leitura por id no banco (storage.loadConversationsByIds). */
  loadByIds: (ids: string[]) => Promise<Conversation[]>
  /** Põe na tela a Central lida do banco. */
  addLoaded: (conv: Conversation) => void
  /** Cria a Central ao fundo, sem trocar a conversa aberta. */
  create: () => Conversation
}

/** Acha, carrega ou cria a Central; null quando a leitura do banco falhou. */
export async function ensureCentral(d: CentralBootDeps): Promise<Conversation | null> {
  const known = d.convsRef.current.find((c) => c.id === CENTRAL_ID)
  if (known) return known
  let found: Conversation | undefined
  try {
    found = (await d.loadByIds([CENTRAL_ID])).find((c) => c.id === CENTRAL_ID)
  } catch (error) {
    // Leitura que falhou NÃO vira criação: uma Central vazia gravada por cima da
    // que existe no banco apagaria o histórico dela. O próximo gatilho tenta de novo.
    console.warn('[central] não foi possível ler a Central:', error instanceof Error ? error.message : String(error))
    return null
  }
  // Pode ter chegado enquanto lia (feed de mudanças de outra instalação).
  const arrived = d.convsRef.current.find((c) => c.id === CENTRAL_ID)
  if (arrived) return arrived
  if (found) {
    d.addLoaded(found)
    // A leitura já a registrou para a gravação: fora da lista, o próximo
    // salvamento a apagaria do banco. Entra na ref já, antes do render.
    d.convsRef.current = [found, ...d.convsRef.current]
    return found
  }
  const created = d.create()
  if (!d.convsRef.current.some((c) => c.id === created.id)) d.convsRef.current = [created, ...d.convsRef.current]
  return created
}

/**
 * Roda `ensureCentral` uma vez depois da hidratação e devolve o mesmo gatilho
 * para quem precisa dela antes de o boot terminar (clique na barra, mensagem do
 * celular). Um por vez: o efeito duplo do StrictMode e os gatilhos em paralelo
 * esperam a MESMA promessa — a Central nunca nasce duas vezes.
 */
export function useCentralBoot(
  deps: CentralBootDeps & { hydrated: boolean }
): () => Promise<Conversation | null> {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const inflight = useRef<Promise<Conversation | null> | null>(null)
  const ensure = useCallback((): Promise<Conversation | null> => {
    // Antes da hidratação a carga inicial ainda vai substituir a lista inteira.
    if (!depsRef.current.hydrated) return Promise.resolve(null)
    if (!inflight.current) {
      inflight.current = ensureCentral(depsRef.current).finally(() => {
        inflight.current = null
      })
    }
    return inflight.current
  }, [])
  useEffect(() => {
    if (deps.hydrated) void ensure()
  }, [deps.hydrated, ensure])
  return ensure
}
