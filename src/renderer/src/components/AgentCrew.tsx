import { useEffect, useMemo, useState } from 'react'
import {
  buildLanes,
  JUST_STARTED_MS,
  type CrewMember,
  type CrewState
} from '../crew'
import type { TrackStep } from '../agentTracks'
import { CrewRoleIcon } from './CrewIcons'

/**
 * O ELENCO na tela. Cada papel é uma presença fixa: parado fica recuado,
 * trabalhando acende na cor do papel com anel girando, cronômetro e uma
 * varredura na borda. É o contraste entre os dois que torna "começou a
 * trabalhar" perceptível sem o usuário estar olhando para cá.
 *
 * Classes prefixadas com `crew-`: os nomes do mockup (`.agent`, `.badge`,
 * `.step`…) são genéricos demais para uma folha de 6,5 mil linhas — a
 * aparência é a mesma, o risco de colisão não.
 */

/** Cronômetro do cartão trabalhando: `m:ss`, como o mockup. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Quando terminou, em linguagem de relance: "há 40s", "há 2 min". */
export function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `há ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `há ${m} min`
  return `há ${Math.floor(m / 60)}h`
}

/** Duração de um passo: segundos inteiros enquanto couber. */
function fmtStep(step: TrackStep, now: number): string {
  const s = Math.max(0, Math.floor(((step.endedAt ?? now) - step.startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}min`
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

function stateClass(state: CrewState): string {
  return state
}

function MemberCard({ member, now }: { member: CrewMember; now: number }): JSX.Element {
  // O que está trabalhando nasce aberto — é o cartão que o usuário quer ler.
  // Depois disso quem manda é o clique dele.
  const [override, setOverride] = useState<boolean | null>(null)
  const hasSteps = (member.steps?.length ?? 0) > 0
  const open = hasSteps && (override ?? member.state === 'working')
  const justStarted =
    member.state === 'working' &&
    member.startedAt != null &&
    now - member.startedAt < JUST_STARTED_MS

  const className = [
    'crew-agent',
    stateClass(member.state),
    justStarted ? 'just-started' : '',
    hasSteps ? 'clickable' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const time =
    member.state === 'working' && member.startedAt != null
      ? fmtClock(now - member.startedAt)
      : member.endedAt != null
        ? fmtAgo(now - member.endedAt)
        : null

  return (
    <article
      className={className}
      style={{ ['--role' as string]: `var(--crew-${member.role})` }}
      {...(hasSteps
        ? {
            onClick: () => setOverride((v) => !(v ?? member.state === 'working')),
            role: 'button',
            tabIndex: 0,
            'aria-expanded': open,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setOverride((v) => !(v ?? member.state === 'working'))
              }
            }
          }
        : {})}
    >
      <span className="crew-av" aria-hidden="true">
        <span className="crew-ring" />
        <CrewRoleIcon role={member.role} />
      </span>
      <span className="crew-who">
        <span className="crew-name">
          {member.name}
          {member.kind && <span className="crew-kind">{member.kind}</span>}
        </span>
        <span className="crew-doing">
          {member.line.map((seg, i) =>
            seg.kind === 'text' ? (
              <span key={i}>{seg.text}</span>
            ) : (
              <span key={i} className={`crew-${seg.kind}`}>
                {seg.text}
              </span>
            )
          )}
        </span>
      </span>
      <span className="crew-meta">
        {member.state === 'working' ? (
          time && <span className="crew-elapsed">{time}</span>
        ) : member.badge ? (
          // `plain` é texto miúdo, não pílula: "disponível" não é um resultado.
          member.badge.tone === 'plain' ? (
            <span className="crew-steps">{member.badge.text}</span>
          ) : (
            <span className={`crew-badge ${member.badge.tone}`}>{member.badge.text}</span>
          )
        ) : null}
        {member.state === 'working' && member.stepCount != null ? (
          <span className="crew-steps">
            {member.stepCount} chamada{member.stepCount === 1 ? '' : 's'}
          </span>
        ) : member.state !== 'working' && time ? (
          <span className="crew-steps">{time}</span>
        ) : null}
      </span>
      {open && member.steps && (
        <ol className="crew-steps-list">
          {member.steps.slice(-6).map((step) => (
            <li
              key={step.id}
              className={`crew-step ${step.endedAt ? (step.isError ? 'err' : 'done') : 'run'}`}
            >
              <span className="crew-st-dot" />
              <span className="crew-st-name">{step.name}</span>
              <span className="crew-st-detail">{describeStepInput(step)}</span>
              <span className="crew-st-time">{fmtStep(step, now)}</span>
            </li>
          ))}
        </ol>
      )}
    </article>
  )
}

function describeStepInput(step: TrackStep): string {
  const i = (step.input ?? {}) as Record<string, unknown>
  for (const k of ['file_path', 'path', 'notebook_path', 'command', 'pattern', 'query', 'description']) {
    const v = i[k]
    if (typeof v === 'string' && v.trim()) {
      const clean = v.trim().replace(/\s+/g, ' ')
      const short = k.endsWith('path') ? clean.split(/[\\/]/).slice(-1)[0] : clean
      return short.length > 40 ? `${short.slice(0, 39)}…` : short
    }
  }
  return ''
}

/** Cinco marcas de tempo ao longo da janela do turno, como no mockup. Os
 *  rótulos são calculados da janela real — um eixo com números fixos mentiria
 *  sobre a duração assim que o turno passasse deles. */
function ticks(crew: CrewMember[], now: number): string[] {
  const marks = crew.flatMap((m) => [m.startedAt, m.endedAt].filter((v): v is number => v != null))
  if (marks.length === 0) return []
  const start = Math.min(...marks)
  const span = Math.max(0, now - start)
  return [0, 0.25, 0.5, 0.75, 1].map((f) => fmtClock(span * f))
}

function Timeline({ crew, now }: { crew: CrewMember[]; now: number }): JSX.Element {
  const lanes = useMemo(() => buildLanes(crew, now), [crew, now])
  if (lanes.length === 0) {
    return (
      <div className="crew-timeline">
        <p className="crew-empty">
          Ninguém trabalhou nesta conversa ainda. Quando o agente delegar, as faixas aparecem aqui.
        </p>
      </div>
    )
  }
  return (
    <div className="crew-timeline">
      <p className="crew-tl-lead">
        O mesmo turno visto por sobreposição: quem rodou junto de quem, e quem ainda está vivo.
      </p>
      {lanes.map((lane) => (
        <div
          className="crew-tl-row"
          key={lane.member.id}
          style={{ ['--role' as string]: `var(--crew-${lane.member.role})` }}
        >
          <span className="crew-tl-name">
            <CrewRoleIcon role={lane.member.role} size={12} />
            {lane.member.name}
          </span>
          <span className="crew-tl-track">
            <span
              className={`crew-tl-bar${lane.live ? ' live' : ''}`}
              style={{ left: `${lane.left}%`, width: `${lane.width}%` }}
            />
          </span>
        </div>
      ))}
      <div className="crew-tl-axis">
        <span />
        <span className="crew-tl-ticks">
          {ticks(crew, now).map((t, i, all) => (
            // A chave é a posição: num turno recém-começado todas as marcas
            // ainda leem "0:00" e o texto não serve como identidade.
            <span key={i}>{i === all.length - 1 ? 'agora' : t}</span>
          ))}
        </span>
      </div>
    </div>
  )
}

interface Props {
  crew: CrewMember[]
}

export function AgentCrew({ crew }: Props): JSX.Element {
  const [view, setView] = useState<'elenco' | 'linha'>('elenco')
  const anyWorking = crew.some((m) => m.state === 'working')
  const now = useNow(anyWorking)

  const conversa = crew.filter((m) => m.group === 'conversa')
  const observadores = crew.filter((m) => m.group === 'observadores')

  return (
    <div className="crew">
      <div className="crew-head">
        <h3>Equipe</h3>
        <span className="crew-seg" role="group" aria-label="Modo de visualização da equipe">
          <button
            type="button"
            className={view === 'elenco' ? 'on' : ''}
            onClick={() => setView('elenco')}
          >
            Elenco
          </button>
          <button
            type="button"
            className={view === 'linha' ? 'on' : ''}
            onClick={() => setView('linha')}
          >
            Linha do tempo
          </button>
        </span>
      </div>

      {view === 'linha' ? (
        <Timeline crew={crew} now={now} />
      ) : (
        <div className="crew-roster">
          <p className="crew-group-label">Nesta conversa</p>
          {conversa.map((m) => (
            <MemberCard key={m.id} member={m} now={now} />
          ))}
          {observadores.length > 0 && (
            <>
              <p className="crew-group-label">Observadores — rodam sozinhos</p>
              {observadores.map((m) => (
                <MemberCard key={m.id} member={m} now={now} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
