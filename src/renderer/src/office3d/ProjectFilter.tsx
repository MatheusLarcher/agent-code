/**
 * Filtro de projeto no HUD do Escritório 3D: a pílula mostra o projeto em vigor
 * ("Todos" sem filtro) e abre a lista — Todos + os projetos no escritório, com o
 * ícone (feed.projectIcons) e quantos agentes cada um tem. A escolha vai ao
 * motor (`engine.setProjectFilter`), que guarda e aplica (engineFilter.ts).
 *
 * Aberta, a lista fecha com Esc (de captura: não chega ao motor), clique fora
 * ou ao escolher.
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import type { ProjectLayout } from './layout'
import { accentHue, iconSource } from './sign'

/** Aberto, fecha com Esc (sem deixar o Esc chegar ao motor) ou com um clique fora de `box`. */
export function useDismiss(open: boolean, close: () => void, box: RefObject<HTMLElement | null>): void {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node) || !box.current?.contains(e.target)) closeRef.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      closeRef.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, box])
}

/** Ícone do projeto: a imagem, o emoji ou a inicial na cor dele. */
export function ProjectIcon({ project }: { project: Pick<ProjectLayout, 'id' | 'name' | 'icon'> }): JSX.Element {
  const src = iconSource(project.icon, project.name)
  if (src.kind === 'image') return <img className="o3d-pf-icon" src={src.src} alt="" aria-hidden="true" />
  if (src.kind === 'glyph')
    return (
      <span className="o3d-pf-icon glyph" aria-hidden="true">
        {src.text}
      </span>
    )
  return (
    <span className="o3d-pf-icon initial" style={{ background: `hsl(${accentHue(project.id)} 42% 46%)` }} aria-hidden="true">
      {src.text}
    </span>
  )
}

export interface ProjectFilterProps {
  projects: readonly ProjectLayout[]
  /** O filtro em vigor (null = Todos). */
  filter: string | null
  onFilter(id: string | null): void
}

export function ProjectFilter({ projects, filter, onFilter }: ProjectFilterProps): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useDismiss(open, () => setOpen(false), box)
  if (projects.length === 0) return null
  const current = filter ? projects.find((p) => p.id === filter) : undefined
  const total = projects.reduce((n, p) => n + p.agents, 0)
  const pick = (id: string | null): void => {
    setOpen(false)
    if (id !== filter) onFilter(id)
  }
  const agents = (n: number): string => `${n} ${n === 1 ? 'agente' : 'agentes'}`
  return (
    <div className="o3d-pf" ref={box}>
      <button
        type="button"
        className={`o3d-glass o3d-pf-btn${open ? ' on' : ''}${current ? ' filtered' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Projeto no escritório: ${current ? current.name : 'Todos'}`}
        title="Filtrar o escritório por projeto"
        onClick={() => setOpen((v) => !v)}
      >
        {current ? <ProjectIcon project={current} /> : <span className="o3d-pf-icon all" aria-hidden="true" />}
        <span className="o3d-pf-name">{current ? current.name : 'Todos os projetos'}</span>
        <span className="o3d-pf-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="o3d-pf-pop" role="menu" aria-label="Filtrar por projeto">
          <button type="button" role="menuitemradio" aria-checked={!current} className="o3d-pf-item" onClick={() => pick(null)}>
            <span className="o3d-pf-icon all" aria-hidden="true" />
            <span className="o3d-pf-name">Todos</span>
            <span className="o3d-pf-count">{agents(total)}</span>
          </button>
          {projects.map((p) => (
            <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === current?.id} className="o3d-pf-item" onClick={() => pick(p.id)}>
              <ProjectIcon project={p} />
              <span className="o3d-pf-name">{p.name}</span>
              <span className="o3d-pf-count">{agents(p.agents)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
