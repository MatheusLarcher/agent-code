import type { Conversation } from '../types'
import type { NotifyOptions, ToastType } from '../ui/UiProvider'
import { ipcErrorMessage } from '../ipcError'

/**
 * Abrir a conversa de um envio (o clique no toast e na TV Implantação). A tela
 * Entregas saiu da tela principal; os envios agora se veem no quadro (a faixa
 * Próximos prompts) e na TV do escritório.
 */
export interface OpenConversationDeps {
  /** As conversas na tela (a ref do App: o estado só chega a ela no próximo render). */
  convsRef: { current: Conversation[] }
  /** Leitura por id no banco (storage.loadConversationsByIds). */
  loadByIds: (ids: string[]) => Promise<Conversation[]>
  /** Põe na tela uma conversa lida do banco. */
  addLoaded: (conv: Conversation) => void
  /** O mesmo caminho da barra lateral (selectConversation). */
  select: (id: string) => void
  notify: (tipo: ToastType, msg: string, opts?: NotifyOptions) => void
}

/**
 * Abre a conversa de um envio. A barra só carrega a 1ª página de cada projeto:
 * a conversa fora dela é lida do banco por id e entra na tela antes de abrir
 * (fora da lista, o próximo salvamento a apagaria).
 */
export async function openConversationById(id: string, d: OpenConversationDeps): Promise<void> {
  if (d.convsRef.current.some((c) => c.id === id)) {
    d.select(id)
    return
  }
  let found: Conversation | undefined
  try {
    found = (await d.loadByIds([id])).find((c) => c.id === id)
  } catch (err) {
    d.notify('erro', `Não foi possível abrir a conversa: ${ipcErrorMessage(err, 'falha ao ler do banco')}`)
    return
  }
  if (!found) {
    d.notify('aviso', 'A conversa deste envio não existe mais.')
    return
  }
  if (!d.convsRef.current.some((c) => c.id === id)) {
    d.addLoaded(found)
    d.convsRef.current = [found, ...d.convsRef.current]
  }
  d.select(id)
}
