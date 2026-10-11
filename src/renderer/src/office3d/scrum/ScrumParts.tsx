/**
 * Peças pequenas do painel do Scrum Master: a linha e a etiqueta do projeto
 * (o ícone dele num quadradinho na cor do projeto — sem ícone, a pasta), o chip
 * do veredito e a trilha do prazo 0→300%.
 */
import type { CSSProperties } from 'react'
import type { ScrumEnvioView, ScrumTipoDesvio, ScrumVereditoTipo } from '@shared/scrumPanel'
import { ProjectNameIcon } from '../../components/projectIcons'
import { projectName, trackOf, verdictOf } from './scrumPanelText'

/** A cor do projeto por pasta (o painel recebe do escritório; sem ela, a cor de destaque). */
export type ProjectColorOf = (cwd: string | null) => string

const pcStyle = (color: string): CSSProperties => ({ ['--pc' as string]: color })

/** A linha do projeto no cartão do envio: ícone, nome sublinhado na cor e o caminho apagado. */
export function ProjectRow({ cwd, color }: { cwd: string; color: string }): JSX.Element {
  return (
    <div className="smp-projrow" style={pcStyle(color)} title={cwd} data-testid="smp-projrow">
      <span className="smp-pico">
        <ProjectNameIcon cwd={cwd} size={13} />
      </span>
      <span className="smp-pname">{projectName(cwd)}</span>
      <span className="smp-ppath">{cwd}</span>
    </div>
  )
}

/** A etiqueta do projeto num item do Histórico. */
export function ProjectTag({ cwd, color }: { cwd: string | null; color: string }): JSX.Element {
  return (
    <span className="smp-projtag" style={pcStyle(color)} title={cwd ?? undefined} data-testid="smp-projtag">
      <span className="smp-pico mini">{cwd ? <ProjectNameIcon cwd={cwd} size={10} /> : null}</span>
      {projectName(cwd)}
    </span>
  )
}

export function Verdict({ v, tipo }: { v: ScrumVereditoTipo | null; tipo: ScrumTipoDesvio | null }): JSX.Element | null {
  const chip = verdictOf(v, tipo)
  return chip ? <span className={`smp-verdict ${chip.cls}`}>{chip.text}</span> : null
}

/** A trilha 0 → 100 → 150 → 200 → 300%, os marcos acesos e o ponteiro "tempo ativo / prazo". */
export function Track({ envio }: { envio: ScrumEnvioView }): JSX.Element {
  const { marks, now } = trackOf(envio)
  return (
    <div className="smp-track" data-testid="smp-track" aria-label={now ? `Tempo ativo ${now.label}` : 'Sem prazo'}>
      <div className="smp-bar" />
      {marks.map((m) => (
        <span key={m.pct}>
          <span className={`smp-m${m.hit ? ' hit' : ''}${m.bad ? ' bad' : ''}`} style={{ left: `${m.left}%` }} data-pct={m.pct}>
            {m.glyph}
          </span>
          {m.pct > 0 ? (
            <span className="smp-lbl" style={{ left: `${m.left}%` }}>
              {m.pct}%
            </span>
          ) : null}
        </span>
      ))}
      {now ? <span className="smp-now" style={{ left: `${now.left}%` }} data-t={now.label} data-testid="smp-now" /> : null}
    </div>
  )
}
