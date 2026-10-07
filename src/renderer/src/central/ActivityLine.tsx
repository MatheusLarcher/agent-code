/**
 * A linha-resumo (o botão que abre os cartões de uma resposta), no desenho da
 * Central: terminada, ▸/▾ + resumo + "N ações"; rodando, o spinner (na cor
 * `--c` de quem monta), o resumo até ali e "agora: …". Usada pelos blocos da
 * Central e pelas respostas do chat (ChatStep).
 */
import type { CentralActivity, CentralActivitySegment } from '@shared/central'
import { actionsLabel } from './centralView'

const TONE_CLASS: Record<NonNullable<CentralActivitySegment['tone']>, string> = {
  strong: 'strong',
  add: 'add',
  rem: 'rem',
  ok: 'okc',
  bad: 'bad'
}

export function Segments({ segments }: { segments: readonly CentralActivitySegment[] }): JSX.Element {
  return (
    <>
      {segments.map((s, i) =>
        s.tone === 'strong' ? (
          <b key={i}>{s.text}</b>
        ) : s.tone ? (
          <span key={i} className={TONE_CLASS[s.tone]}>
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </>
  )
}

export interface ActivityLineProps {
  activity: Partial<CentralActivity>
  running: boolean
  open: boolean
  onToggle: () => void
  /** O texto quando o resumo vem vazio (só bastidor ou só pensamento); ausente = "trabalhando…"/nada. */
  fallback?: string
}

export function ActivityLine({ activity: a, running, open, onToggle, fallback = '' }: ActivityLineProps): JSX.Element {
  const segments = Array.isArray(a.segments) ? a.segments : []
  const count = typeof a.count === 'number' ? a.count : 0
  const idle = running && count === 0 && !a.now
  return (
    <button
      type="button"
      className={`central-act${running ? ' running' : ''}`}
      title={a.text || 'Clique para ver cada ação'}
      aria-expanded={open}
      onClick={onToggle}
    >
      {running ? <span className="central-spin" aria-hidden="true" /> : <span className="central-chev" aria-hidden="true">{open ? '▾' : '▸'}</span>}
      <span className="central-sum">
        {idle && !fallback ? (
          'trabalhando…'
        ) : segments.length === 0 && !a.now && fallback ? (
          fallback
        ) : (
          <>
            <Segments segments={segments} />
            {running && a.now && `${segments.length ? ' · ' : ''}agora: ${a.now}`}
          </>
        )}
      </span>
      {count > 0 && <span className="central-count">{actionsLabel(count)}</span>}
    </button>
  )
}
