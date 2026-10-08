/**
 * A obra do plano na Tela de Planejamento (planObra.ts decide, aqui só desenha):
 *   ObraSeal     o selo do cabeçalho — "Na prancheta" antes de enviar, depois o
 *                estágio da obra (Em obra, Vistoria, Habite-se…);
 *   PlacaDaObra  a placa da obra embaixo do cabeçalho, depois do envio: a fita
 *                zebrada, o guindaste içando um tijolo (a casa pronta no
 *                habite-se), "Etapa N de M" (a posição no plano, de
 *                planProgress), a frase, os tijolos (uma etapa do plano por
 *                tijolo), o mestre de obras (a conversa de implementação, com
 *                "Ver a obra"), o tempo de obra × prazo e o início.
 * Movimento só enquanto a obra anda, e nenhum com prefers-reduced-motion.
 */
import './planObra.css'
import { tempoAtivoMinutos } from '@shared/handoffTracking'
import { BRICK_LABEL, inicioText, minutosText, OBRA_LABEL, type BrickState, type ObraStage, type ObraView } from './planObra'

const ART_TITLE: Partial<Record<ObraStage, string>> = { habitese: 'Obra entregue' }

function SealIcon({ stage }: { stage: ObraStage }): JSX.Element {
  if (stage === 'prancheta') {
    // Esquadro de desenho: o plano ainda está sendo traçado.
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M2.5 13.5v-11l11 11z M5.5 10.5V8l2.5 2.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    )
  }
  if (stage === 'habitese') {
    // A chave da casa entregue.
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="5" cy="8" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7.8 8h6M11.5 8v2.4M13.6 8v1.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }
  // Capacete de obra.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.8 12.2h12.4M3 12.2V10a5 5 0 0 1 10 0v2.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6.6 5.3V3.6h2.8v1.7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  )
}

/** O selo do cabeçalho; o detalhe (a frase da placa) no title. */
export function ObraSeal({ obra }: { obra: ObraView }): JSX.Element {
  return (
    <span className={`pl-obra-seal s-${obra.stage}`} title={obra.headline} data-stage={obra.stage}>
      <SealIcon stage={obra.stage} />
      {OBRA_LABEL[obra.stage]}
    </span>
  )
}

/** O guindaste içando um tijolo; no habite-se, a casa pronta. */
function ObraArt({ stage }: { stage: ObraStage }): JSX.Element {
  if (stage === 'habitese') {
    return (
      <svg className="pl-obra-art" viewBox="0 0 48 48" role="img" aria-label={ART_TITLE.habitese}>
        <path d="M7 23L24 9l17 14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" />
        <path d="M11 21v19h26V21" fill="none" stroke="currentColor" strokeWidth="2" />
        <rect x="20.5" y="28" width="7" height="12" rx="1" fill="currentColor" opacity="0.85" />
        <rect x="14" y="25" width="4.5" height="4.5" rx="0.6" fill="currentColor" opacity="0.5" />
        <rect x="29.5" y="25" width="4.5" height="4.5" rx="0.6" fill="currentColor" opacity="0.5" />
        <path d="M33 9v6" stroke="currentColor" strokeWidth="2" />
        <path className="pl-obra-flag" d="M33 9h7l-2 2 2 2h-7z" fill="currentColor" />
      </svg>
    )
  }
  return (
    <svg className="pl-obra-art" viewBox="0 0 48 48" aria-hidden="true">
      {/* Torre treliçada, base e a lâmpada de aviso no topo. */}
      <path d="M11 45V12M17 45V12M11 18l6-6M11 24l6-6M11 30l6-6M11 36l6-6M11 42l6-6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 45.5h14" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <circle className="pl-obra-lamp" cx="14" cy="3.6" r="1.7" />
      {/* Lança, tirantes e contrapeso. */}
      <path d="M3 12h43" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M14 12V5.5M14 5.5L44 12M14 5.5L4 12" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.75" />
      <rect x="3" y="13" width="6" height="5" rx="1" fill="currentColor" opacity="0.7" />
      {/* Carrinho, cabo, gancho e o tijolo içado. */}
      <rect x="35" y="12.5" width="5" height="2.4" rx="0.5" fill="currentColor" />
      <line className="pl-obra-cable" x1="37.5" y1="14.9" x2="37.5" y2="26" stroke="currentColor" strokeWidth="1" />
      <g className="pl-obra-load">
        <path d="M37.5 26v2.2a1.7 1.7 0 1 1-1.7-1.7" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        <rect className="pl-obra-carried" x="33" y="30.5" width="9" height="5" rx="0.8" />
      </g>
    </svg>
  )
}

const COUNT_ORDER: BrickState[] = ['pronto', 'massa', 'fila', 'trinca', 'planta']

function countText(state: BrickState, n: number): string {
  if (state === 'pronto') return n === 1 ? '1 pronta' : `${n} prontas`
  if (state === 'trinca') return n === 1 ? '1 incompleta' : `${n} incompletas`
  return `${n} ${BRICK_LABEL[state]}`
}

function tempoText(obra: ObraView): string {
  const ativo = minutosText(tempoAtivoMinutos(obra.tempo.ativoMs))
  if (obra.tempo.prazoMin === null) return `${ativo} · sem prazo`
  const prazo = `${ativo} de ${minutosText(obra.tempo.prazoMin)}`
  return obra.tempo.level === 'estourado' ? `${prazo} · estourou o prazo` : prazo
}

export interface PlacaDaObraProps {
  obra: ObraView
  /** Abre a conversa de implementação (no Escritório, a câmera vai até o agente no PC). */
  onOpenConversation?: (conversationId: string) => void
  /** Relógio para o "hoje, 20:51" (testes). */
  now?: number
}

export function PlacaDaObra({ obra, onOpenConversation, now = Date.now() }: PlacaDaObraProps): JSX.Element {
  const bricks = obra.progress.steps
  const counts = COUNT_ORDER.map((s) => [s, bricks.filter((b) => b.state === s).length] as const).filter(([, n]) => n > 0)
  const mestre = obra.mestre
  return (
    <section className={`pl-obra s-${obra.stage}`} aria-label="Placa da obra" data-stage={obra.stage}>
      <div className="pl-obra-tape" aria-hidden="true" />
      <div className="pl-obra-body">
        <ObraArt stage={obra.stage} />
        <div className="pl-obra-main">
          <p className="pl-obra-headline">
            {obra.etapa ? (
              <span className="pl-obra-step">
                Etapa {obra.etapa.n} de {obra.etapa.total}
              </span>
            ) : null}
            {obra.headline}
          </p>
          {obra.detail && <p className="pl-obra-detail">{obra.detail}</p>}
          {bricks.length > 0 && (
            <div className="pl-obra-wall">
              <ol className="pl-obra-bricks" aria-label="Tijolos da obra: uma etapa do plano por tijolo">
                {bricks.map((b) => (
                  <li
                    key={b.id}
                    className={`pl-brick b-${b.state}`}
                    title={`${b.n}. ${b.titulo} — ${BRICK_LABEL[b.state]}`}
                    aria-label={`Etapa ${b.n}, ${b.titulo}: ${BRICK_LABEL[b.state]}`}
                  />
                ))}
              </ol>
              <span className="pl-obra-count">{counts.map(([s, n]) => countText(s, n)).join(' · ')}</span>
            </div>
          )}
        </div>
        <dl className="pl-obra-facts">
          {mestre && (
            <div>
              <dt>Mestre de obras</dt>
              <dd title={mestre.title}>{mestre.title}</dd>
            </div>
          )}
          <div>
            <dt>Tempo de obra</dt>
            <dd className={`lvl-${obra.tempo.level}`} title="Tempo ativo medido pelo app (pausa quando o agente espera você) × a estimativa do plano.">
              {tempoText(obra)}
            </dd>
          </div>
          {obra.inicio && (
            <div>
              <dt>Início</dt>
              <dd>{inicioText(obra.inicio, now)}</dd>
            </div>
          )}
        </dl>
        {mestre && onOpenConversation && (
          <button type="button" className="btn small pl-obra-open" title="Abrir a conversa de implementação" onClick={() => onOpenConversation(mestre.conversationId)}>
            Ver a obra
          </button>
        )}
      </div>
    </section>
  )
}
