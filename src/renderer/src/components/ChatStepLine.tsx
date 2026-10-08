/**
 * A linha de passos de uma resposta NO CHAT (mockup chat-visual-20261007): sem
 * fundo nem borda, o chevron na frente (gira ao abrir), o ícone do grupo, as
 * pílulas com ícone + contador (o "3 buscas" vai no tooltip, HoverTip.tsx) e o resumo da Central em
 * cinza. Rodando, o spinner vem logo depois do chevron e o resumo diz "agora: …" —
 * exceto com a linha ao vivo (ChatLive) presente, que já mostra isso.
 *
 * Mantém as classes da linha da Central (.central-act, .central-sum,
 * .central-spin, .central-chev) para quem já as procura, mas o visual é só do
 * chat (.chat-act, chatLook.css) — a Central segue com o ActivityLine dela.
 */
import type { CentralActivity } from '@shared/central'
import { CountUp } from '../chatAnim'
import { Segments } from '../central/ActivityLine'
import { StepKindIcon } from './StepKindIcon'
import { StepPillRow } from './StepPillRow'
import type { StepPill } from './stepPills'

export interface ChatStepLineProps {
  activity: CentralActivity
  pills: readonly StepPill[]
  icon: 'find' | 'code' | 'tool'
  running: boolean
  /** A linha ao vivo (ChatLive) já diz o que acontece agora: sem spinner nem "agora: …" aqui. */
  live?: boolean
  open: boolean
  onToggle: () => void
  fallback: string
  /** Chegou ao vivo: os contadores sobem de 0 (CountUp). */
  animate: boolean
}

export function ChatStepLine({ activity: a, pills, icon, running, live = false, open, onToggle, fallback, animate }: ChatStepLineProps): JSX.Element {
  const segments = a.segments
  // Com a linha ao vivo no fim, o status do passo em andamento fica só lá (sem duplicar).
  const status = running && !live
  const idle = status && a.count === 0 && !a.now
  return (
    <button
      type="button"
      className={`central-act chat-act${running ? ' running' : ''}`}
      title={a.text || 'Clique para ver cada ação'}
      aria-expanded={open}
      onClick={onToggle}
    >
      <span className="central-chev" aria-hidden="true">
        ›
      </span>
      {status && <span className="central-spin" aria-hidden="true" />}
      <span className={`chat-act-ico ${icon}`} aria-hidden="true">
        <StepKindIcon kind={icon} size={13} />
      </span>
      <StepPillRow pills={pills} count={(n) => <CountUp value={n} animate={animate} />} />
      <span className="central-sum">
        {idle && !fallback ? (
          'trabalhando…'
        ) : segments.length === 0 && !a.now && fallback ? (
          fallback
        ) : (
          <>
            <Segments segments={segments} />
            {status && a.now && `${segments.length ? ' · ' : ''}agora: ${a.now}`}
          </>
        )}
      </span>
    </button>
  )
}
