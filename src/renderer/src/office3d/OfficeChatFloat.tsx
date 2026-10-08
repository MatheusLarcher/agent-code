/**
 * O chat do Escritório 3D: o MESMO painel flutuante do Agent Manager
 * (ChatFloat — translúcido, expande ao clicar nele), com o ChatPanel da
 * conversa ativa dentro, em modo compacto quando minimizado. Aqui "fora" é só a
 * área do escritório (`collapseScope` 'area'): clicar no palco (canvas, HUD)
 * minimiza; a barra lateral e a barra de cima não mexem no chat. O minimizado
 * fica lembrado à parte do Planejamento (mainTabState). Maximizado, o cabeçalho
 * do chat não tem o medidor de consumo nem o aviso "Controle do Windows ativo":
 * só uma barrinha fatiada por tipo de consumo (UsageMiniBar, `usageMini`), que
 * mostra os detalhes e o custo ao passar o mouse e abre o painel por agente ao
 * clicar. O aviso do Windows fica no HUD do palco, com o "Desativar".
 *
 * Cabeçalho: um ponto na cor da camisa do agente da conversa (a cor do
 * projeto, `agentColor`), o título da conversa, o projeto e o 📍, que minimiza o chat e voa a
 * câmera até a mesa dele (`collapseSignal`, que quem hospeda sobe). A borda do
 * painel é neutra (office3d.css). Com a Central no painel (`central`: nenhuma
 * mesa selecionada, ou a Central é a conversa ativa), o cabeçalho é o dela —
 * orbe e "Central", sem projeto nem 📍 (ela não tem mesa) — e a cor é o
 * --accent. Com o "Fala, PO" aberto (poChatOpen: o botão do quadro ou o clique
 * no PO), o cabeçalho é o dele: orbe, "Fala, PO" e o projeto. O maximizado
 * nunca sobe na faixa do HUD (a de cima, que os balões também respeitam —
 * BUBBLE_TOP).
 */
import '../central/central.css'
import type { CSSProperties, ReactNode } from 'react'
import { CENTRAL_TITLE } from '@shared/central'
import { ChatFloat, floatTop, type ChatFloatDisplay, type ChatFloatPersist, type FloatGeometry } from '../components/ChatFloat'
import { loadOfficeChatMinimized, saveOfficeChatMinimized } from '../components/mainTabState'
import { principalKey, roomName } from '../office/adapter/model'
import { PO_CHAT_TITLE } from '../poChat/PoChatPanel'
import { projectNameOf, usePoChatOpen } from '../poChat/poChatOpen'
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
const DISPLAY: ChatFloatDisplay = { hideLastUsage: true, hideWindowsBanner: true, usageMini: true }

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
  /** A cor do agente da conversa: a do projeto (projectColor.ts `agentCss`); sem ela, a seed. */
  agentColor?: string
}

export function OfficeChatFloat({ children, conversation, central = false, expandSignal, collapseSignal, onLocate, agentColor }: OfficeChatFloatProps): JSX.Element {
  const po = usePoChatOpen()
  const color = central || po ? 'var(--accent)' : conversation ? (agentColor ?? seedCss(principalKey(conversation.id))) : null
  const style = color ? ({ '--o3d-agent': color } as CSSProperties) : undefined
  const header = central ? (
    <div className="o3d-chat-head">
      <span className="central-orb small" aria-hidden="true" />
      <span className="o3d-chat-title">{CENTRAL_TITLE}</span>
    </div>
  ) : po ? (
    <div className="o3d-chat-head" data-testid="o3d-chat-po">
      <span className="central-orb small" aria-hidden="true" />
      <span className="o3d-chat-title">{PO_CHAT_TITLE}</span>
      <span className="o3d-chat-project" title={po}>
        {projectNameOf(po)}
      </span>
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
