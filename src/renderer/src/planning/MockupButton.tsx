/**
 * "Ver mockup" no cabeçalho do planejamento: aparece assim que o plano tem uma
 * página .html (no _sandbox, gerada pelo Agent Manager, ou em midia/) e abre a
 * página no Chrome do usuário. Com um mockup, o clique já abre; com vários,
 * abre a lista (o mais novo primeiro). O _sandbox não tem vigia: a lista é
 * relida a cada poucos segundos para o botão surgir quando o Manager gera.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlanningMockupDto } from '@shared/ipc'
import { IconChevronDown, IconGlobe } from '../components/Icons'
import { useUI } from '../ui/UiProvider'

const POLL_MS = 4000

function sameList(a: PlanningMockupDto[], b: PlanningMockupDto[]): boolean {
  return a.length === b.length && a.every((m, i) => m.path === b[i].path && m.mtimeMs === b[i].mtimeMs)
}

function fileName(rel: string): string {
  return rel.split('/').pop() ?? rel
}

export function MockupButton({ projectCwd, slug }: { projectCwd: string; slug: string }): JSX.Element | null {
  const { notify } = useUI()
  const [mockups, setMockups] = useState<PlanningMockupDto[]>([])
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    setMockups([])
    setOpen(false)
    const load = async (): Promise<void> => {
      const list = await Promise.resolve()
        .then(() => window.api.planningListMockups({ projectCwd, slug }))
        .catch(() => null)
      if (alive && Array.isArray(list)) setMockups((cur) => (sameList(cur, list) ? cur : list))
    }
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [projectCwd, slug])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const openMockup = useCallback(
    async (m: PlanningMockupDto): Promise<void> => {
      setOpen(false)
      const res = await window.api
        .planningOpenMockup({ projectCwd, slug, path: m.path })
        .catch((err: unknown) => ({ ok: false as const, message: String(err) }))
      if (!res.ok) notify('erro', `Não consegui abrir o mockup: ${res.message}`)
    },
    [projectCwd, slug, notify]
  )

  if (!mockups.length) return null
  const single = mockups.length === 1 ? mockups[0] : null

  return (
    <div className="pl-mockup" ref={rootRef}>
      <button
        type="button"
        className="btn small pl-mockup-btn"
        title={single ? `Abrir ${single.rel} no navegador` : 'Escolher o mockup para abrir no navegador'}
        aria-haspopup={single ? undefined : 'menu'}
        aria-expanded={single ? undefined : open}
        onClick={() => (single ? void openMockup(single) : setOpen((v) => !v))}
      >
        <IconGlobe size={14} />
        {single ? 'Ver mockup' : `Ver mockup (${mockups.length})`}
        {!single && <IconChevronDown size={12} />}
      </button>
      {open && !single && (
        <ul className="pl-mockup-menu" role="menu">
          {mockups.map((m) => (
            <li key={m.path} role="none">
              <button type="button" role="menuitem" title={m.path} onClick={() => void openMockup(m)}>
                <span className="pl-mockup-name">{fileName(m.rel)}</span>
                <span className="pl-mockup-where">
                  {m.origem === 'midia' ? 'mídia' : 'sandbox'}
                  {m.rel.includes('/') ? ` · ${m.rel.slice(0, m.rel.lastIndexOf('/'))}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
