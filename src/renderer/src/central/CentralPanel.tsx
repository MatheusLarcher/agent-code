/**
 * O painel da Central (no lugar do ChatPanel quando ela é a conversa aberta):
 * cabeçalho com o orbe, o feed dos pedidos e o MESMO Composer do chat (anexos,
 * rascunho, voz). Sem seletor de modelo/esforço/modos, sem tokens, sem plano e
 * sem cartão de recuperação: a Central não roda agente — ela encaminha.
 *
 * Por ora o feed mostra só os pedidos; avisos de destino, respostas, perguntas
 * e o "Para onde vai?" chegam na Etapa 6, junto do trilho do cabeçalho.
 */
import { useEffect, useRef, type RefObject } from 'react'
import type { FileAttachment, FileRefAttachment, ImageAttachment, PickedElement } from '@shared/ipc'
import { CENTRAL_ID, CENTRAL_TITLE, type CentralRequestEntry } from '@shared/central'
import { splitMediaText } from '@shared/inlineMedia'
import { Composer, type RefProject } from '../components/Composer'
import type { DraftMedia } from '../inlineMedia/inlineAttachments'
import type { Conversation } from '../types'
import type { CentralController } from './useCentral'
import './central.css'

export interface CentralPanelProps {
  /** A Central (a conversa de id fixo). */
  conversation: Conversation
  /** O fluxo da Central (useCentral.ts): rota, espelho, perguntas, "não era aqui".
   *  A tela completa que o desenha é da Etapa 5 (mockup v3). */
  controller?: CentralController
  /** TypeSafe configurado. Sem ele, enviar abre as Configurações e o texto fica no campo. */
  ready: boolean
  /** O gate: aviso da Central + Configurações no TypeSafe. */
  onNeedTypesafe: () => void
  onSend: (
    text: string,
    images: ImageAttachment[],
    thumbs: string[],
    files: FileAttachment[],
    fileRefs: FileRefAttachment[]
  ) => void
  onDraftChange: (convId: string, text: string, media?: DraftMedia[]) => void
  /** O campo de texto (o App usa para dar foco). */
  composerRef: RefObject<HTMLElement | null>
  /** Projetos do histórico, no menu "@" do Composer. */
  projects: RefProject[]
}

// Elementos marcados no navegador ficam para o chat normal: a Central não os consome.
const NO_CHIPS: PickedElement[] = []
const noop = (): void => {}

export function CentralPanel(props: CentralPanelProps): JSX.Element {
  const requests = (props.conversation.central?.entries ?? []).filter(
    (e): e is CentralRequestEntry => e.kind === 'request'
  )
  const feedRef = useRef<HTMLDivElement>(null)
  const lastId = requests.at(-1)?.id
  // Pedido novo: o feed desce até ele.
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lastId])

  const send = (
    text: string,
    images: ImageAttachment[],
    files: FileAttachment[],
    fileRefs: FileRefAttachment[]
  ): void => {
    const thumbs = images.map((img) => `data:${img.mediaType};base64,${img.data}`)
    props.onSend(text, images, thumbs, files, fileRefs)
  }

  // Sem TypeSafe a mensagem não sai: o gate abre as Configurações e o Composer
  // recusa o envio sem limpar o campo — texto e anexos ficam para depois.
  const gate = (): boolean => {
    if (props.ready) return true
    props.onNeedTypesafe()
    return false
  }

  return (
    <section className="chat-panel central-panel" aria-label={CENTRAL_TITLE}>
      <header className="central-head">
        <span className="central-orb small" aria-hidden="true" />
        <h1>{CENTRAL_TITLE}</h1>
        {/* Lugar do trilho das conversas trabalhando agora (Etapa 6). */}
        <div className="central-head-rail" />
      </header>

      <div className="central-feed" ref={feedRef}>
        {requests.length === 0 ? (
          <p className="central-empty">Diga o que precisa: a Central leva para a conversa certa.</p>
        ) : (
          requests.map((entry) => <CentralRequestBubble key={entry.id} entry={entry} />)
        )}
      </div>

      <div className="central-composer">
        {/* Sem o escudo de revisão: a Central não tem projeto para revisar. */}
        <Composer
          disabled={false}
          busy={false}
          chips={NO_CHIPS}
          onChipsConsumed={noop}
          onSend={send}
          onInterrupt={noop}
          textareaRef={props.composerRef}
          projects={props.projects}
          projectRoot={null}
          convId={CENTRAL_ID}
          draft={props.conversation.draft ?? ''}
          draftMedia={props.conversation.draftMedia}
          onDraftChange={props.onDraftChange}
          projectMissing={false}
          projectMissingMsg=""
          placeholder="Fale com o agent…"
          hideCodeReview
          beforeSend={gate}
        />
        <div className="central-hint">o destino é escolhido pelo assunto</div>
      </div>
    </section>
  )
}

/** Um pedido: bolha à direita, com o nome de cada anexo no ponto do texto. */
function CentralRequestBubble({ entry }: { entry: CentralRequestEntry }): JSX.Element {
  const names = entry.attachments ?? []
  const parts = splitMediaText(entry.text)
  const inText = new Set<number>()
  for (const part of parts) if ('media' in part) inText.add(part.media)
  // Anexo sem marcador no texto (imagem vinda do celular): vai depois do texto.
  const rest = names.filter((_, i) => !inText.has(i + 1))
  return (
    <div className="central-me" data-entry-id={entry.id}>
      <div className="central-bubble">
        {parts.map((part, i) =>
          'media' in part ? (
            <span key={i} className="central-att">
              {names[part.media - 1] ?? `mídia ${part.media}`}
            </span>
          ) : (
            <span key={i}>{part.text}</span>
          )
        )}
        {rest.length > 0 && (
          <span className="central-atts">
            {rest.map((name, i) => (
              <span key={i} className="central-att">
                {name}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}
