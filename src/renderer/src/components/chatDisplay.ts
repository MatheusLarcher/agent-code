/**
 * Como o `ChatPanel` se mostra, decidido por quem o hospeda — sem prop nova:
 * o painel chega pronto do App (as mesmas props de qualquer conversa), e quem
 * muda é só o lugar onde ele é montado.
 *
 * `compact`: o chat minimizado da Tela de Planejamento. Some o que mede
 * consumo (cabeçalho com entrada/saída/custo e o quadro "Última resposta") e o
 * aviso "Controle do Windows ativo"; conversa, fila e composer continuam.
 *
 * `cardRefs`: os cards do plano aberto (só na Tela de Planejamento). Com eles,
 * '[[' no Composer sugere os cards e [[Nome]] nas mensagens aparece com a cor
 * do tipo do card. Sem eles (ou lista vazia), nada disso existe.
 *
 * Sem provider vale o padrão (`compact: false`, sem cards): o chat normal fica como sempre.
 */
import { createContext, useContext } from 'react'
import type { RefCard } from '../planning/cardRefs'

export interface ChatDisplay {
  compact: boolean
  /** Cards citáveis com [[Nome]] — os do plano aberto no canvas. */
  cardRefs?: readonly RefCard[]
}

export const DEFAULT_CHAT_DISPLAY: ChatDisplay = { compact: false }

export const ChatDisplayContext = createContext<ChatDisplay>(DEFAULT_CHAT_DISPLAY)

export function useChatDisplay(): ChatDisplay {
  return useContext(ChatDisplayContext)
}
