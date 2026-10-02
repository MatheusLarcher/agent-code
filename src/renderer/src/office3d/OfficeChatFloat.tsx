/**
 * O chat do Escritório 3D: o MESMO painel flutuante do Agent Manager
 * (ChatFloat — translúcido, expande ao clicar nele), com o ChatPanel da
 * conversa ativa dentro, em modo compacto quando minimizado. Aqui "fora" é só a
 * área do escritório (`collapseScope` 'area'): clicar no palco (canvas, HUD)
 * minimiza; a barra lateral e a barra de cima não mexem no chat. O minimizado
 * fica lembrado à parte do Planejamento (mainTabState). Diferente do Agent
 * Manager, o aviso "Controle do Windows ativo" continua no maximizado (e o HUD
 * o repete, para o minimizado): aqui o agente é um agente comum.
 *
 * Cabeçalho: um ponto na cor da camisa do agente da conversa (a mesma seed da
 * cena), o título da conversa, o projeto e o 📍, que minimiza o chat e voa a
 * câmera até a mesa dele (`collapseSignal`, que quem hospeda sobe). A borda do
 * painel pega um toque dessa cor. Com a Central no painel (`central`: nenhuma
 * mesa selecionada, ou a Central é a conversa ativa), o cabeçalho é o dela —
 * orbe e "Central", sem projeto nem 📍 (ela não tem mesa) — e a cor é o
 * --accent. O maximizado nunca sobe na faixa do HUD (a de cima, que os balões
 * também respeitam — BUBBLE_TOP).
 */
import '../central/central.css'
import type { CSSProperties, ReactNode } from 'react'
import { CENTRAL_TITLE } from '@shared/central'
import { ChatFloat, floatTop, type ChatFloatDisplay, type ChatFloatPersist, type FloatGeometry } from '../components/ChatFloat'
import { loadOfficeChatMinimized, saveOfficeChatMinimized } from '../components/mainTabState'
import { principalKey, roomName } from '../office/adapter/model'
import { seedCss } from './appearance'
import { BUBBLE_TOP } from './speech'

/** A conversa do chat: o que o cabeçalho mostra. */
export interface OfficeConversation {
  id: string
  title: string
  cwd: string
}

/** O maximizado nunca começa acima disto (px do topo do palco): a faixa do HUD fica livre. */
export const OFFICE_CHAT_MIN_TOP = BUBBLE_TOP + 8

/** Como o do Planejamento (20% da janela), mas sempre abaixo da faixa do HUD. */
export function officeChatTop(g: FloatGeometry): number {
  return Math.max(OFFICE_CHAT_MIN_TOP, floatTop(g))
}

const PERSIST: ChatFloatPersist = { load: loadOfficeChatMinimized, save: saveOfficeChatMinimized }
const DISPLAY: ChatFloatDisplay = { hideLastUsage: true }

export interface OfficeChatFloatProps {
  children: ReactNode
  conversation: OfficeConversation | null
  /** O painel mostra a Central: cabeçalho da Central (orbe, título, sem projeto nem 📍) na cor --accent. */
  central?: boolean
  /** Sobe a cada pedido de expandir (duplo clique num agente). */
  expandSignal?: number
  /** Sobe a cada pedido de minimizar (o 📍, antes do voo). */
  collapseSignal?: number
  /** 📍: voa até a mesa do agente da conversa. */
  onLocate: (convId: string) => void
}

export function OfficeChatFloat({ children, conversation, central = false, expandSignal, collapseSignal, onLocate }: OfficeChatFloatProps): JSX.Element {
  const color = central ? 'var(--accent)' : conversation ? seedCss(principalKey(conversation.id)) : null
  const style = color ? ({ '--o3d-agent': color } as CSSProperties) : undefined
  const header = central ? (
    <div className="o3d-chat-head">
      <span className="central-orb small" aria-hidden="true" />
      <span className="o3d-chat-title">{CENTRAL_TITLE}</span>
    </div>
  ) : (
    <div className="o3d-chat-head">
      <span className="o3d-chat-dot" aria-hidden="true" data-testid="o3d-chat-dot" />
      <span className="o3d-chat-title" title={conversation?.title}>
        {conversation ? conversation.title : 'Nenhuma conversa'}
      </span>
      {conversation && (
        <span className="o3d-chat-project" title={conversation.cwd}>
          {roomName(conversation.cwd)}
        </span>
      )}
      {conversation && (
        <button
          type="button"
          className="o3d-chat-locate"
          onClick={(e) => {
            // Não expande o painel: quem pediu quer ver o agente.
            e.stopPropagation()
            onLocate(conversation.id)
          }}
          aria-label="Voar até a mesa do agente"
          title="Voar até a mesa deste agente"
        >
          📍
        </button>
      )}
    </div>
  )
  return (
    <ChatFloat
      name="Escritório"
      header={header}
      persist={PERSIST}
      display={DISPLAY}
      expandSignal={expandSignal}
      collapseSignal={collapseSignal}
      collapseScope="area"
      maximizedTop={officeChatTop}
      className="o3d-chat"
      style={style}
    >
      {children}
    </ChatFloat>
  )
}
