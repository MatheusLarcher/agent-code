/**
 * Busca a cor fixa de cada projeto conhecido (`window.api.projectColors`, main/
 * projectColor*.ts) e entrega à officeStore, que a junta ao OfficeFeed
 * (`projectColors`). Como o `projectIcons` do App: cada pasta é pedida UMA vez
 * por sessão; um pedido por pasta (a detecção de uma não espera a das outras) e
 * as que chegam juntas saem num só aviso. Sandbox não é pedido (é uma cor só,
 * office3d/projectColor.ts) nem a Central (não é projeto). Não re-renderiza o App.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { isCentralConversation } from '@shared/central'
import { isProjectColor, isSandboxProjectPath, type ProjectColor, type ProjectColorMap } from '@shared/projectColor'
import { officeStore, type OfficeStore } from './officeStore'

type ColorConv = { id: string; cwd?: string | null; mode?: string }
type ColorsApi = (cwds: string[]) => Promise<ProjectColorMap>

/** Junta as cores que chegam juntas num só aviso à store (ms). */
const FLUSH_MS = 30

const isAbsolute = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')

/** As pastas de projeto das conversas que ainda não foram pedidas (sem Central, sandbox nem caminho relativo). */
export function colorCwdsToRequest(conversations: readonly ColorConv[], requested: ReadonlySet<string>): string[] {
  const out = new Set<string>()
  for (const c of conversations) {
    const cwd = c.cwd
    if (!cwd || requested.has(cwd) || isCentralConversation(c) || !isAbsolute(cwd) || isSandboxProjectPath(cwd)) continue
    out.add(cwd)
  }
  return [...out]
}

/** O IPC do PC (estável: o efeito não roda de novo a cada render do App). Sem a ponte (testes), rejeita e fica a reserva. */
const appApi: ColorsApi = (cwds) => {
  const api = (window as { api?: { projectColors?: ColorsApi } }).api
  return typeof api?.projectColors === 'function' ? api.projectColors(cwds) : Promise.reject(new Error('sem window.api.projectColors'))
}

/** O mapa de cores já resolvidas (por cwd), fora do escritório: a Central e a lateral pintam com ele (model.ts `projectColorHex`). */
export function useProjectColorMap(store: Pick<OfficeStore, 'getProjectColors' | 'subscribeProjectColors'> = officeStore): Readonly<ProjectColorMap> {
  return useSyncExternalStore(store.subscribeProjectColors, store.getProjectColors)
}

export function useProjectColors(conversations: readonly ColorConv[], store: Pick<OfficeStore, 'setProjectColors'> = officeStore, api: ColorsApi | null = appApi): void {
  const requested = useRef(new Set<string>())
  const colors = useRef<ProjectColorMap>({})
  const pending = useRef<Record<string, ProjectColor>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => {
    if (!api) return
    const flush = (): void => {
      timer.current = null
      if (!alive.current) return
      colors.current = { ...colors.current, ...pending.current }
      pending.current = {}
      store.setProjectColors(colors.current)
    }
    for (const cwd of colorCwdsToRequest(conversations, requested.current)) {
      requested.current.add(cwd)
      api([cwd]).then(
        (map) => {
          const c = map?.[cwd]
          if (!alive.current || !isProjectColor(c)) return
          pending.current[cwd] = c
          timer.current ??= setTimeout(flush, FLUSH_MS)
        },
        // Pedido recusado: fica a reserva do projeto (office3d/projectColor.ts).
        () => {}
      )
    }
  }, [conversations, api, store])
}
