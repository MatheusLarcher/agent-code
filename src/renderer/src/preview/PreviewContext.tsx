/**
 * Estado da aba Preview (painel da direita) e o `openInPreview` que o resto do
 * app usa para abrir um site ou arquivo ali.
 *
 * Dois contextos de propósito:
 * - PreviewOpenContext: só o `openInPreview`, estável (nunca muda). ToolCard e
 *   Markdown leem por `usePreview()` sem renderizar de novo a cada aba aberta.
 *   Sem provider (testes, janelas soltas), `usePreview()` devolve null e eles
 *   seguem o comportamento antigo.
 * - PreviewStateContext: abas, aba ativa e as ações — só o PreviewPane lê.
 *
 * O App chama `usePreviewController` (para também abrir coisas direto, como as
 * chamadas do escritório) e passa o resultado ao `<PreviewProvider>`.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PickedElement } from '@shared/ipc'
import { previewKindFor, type InspectorPick, type PreviewTab } from '@shared/preview'
import { pickToElement } from './inspector'
import { makeTab, normalizeTarget, resolveRelativeLink, targetKey, titleFor } from './previewTabs'

export interface OpenOptions {
  /** Trazer a aba Preview para a frente (padrão: sim). */
  reveal?: boolean
  /** Pasta de onde vale um link relativo (o .md aberto no Preview); sem ela, a do projeto. */
  base?: string
}

export interface PreviewOpenApi {
  /** Abre (ou volta para) a aba deste link/caminho. false = alvo não reconhecido. */
  openInPreview: (target: string, opts?: OpenOptions) => boolean
}

export interface PreviewState extends PreviewOpenApi {
  tabs: PreviewTab[]
  /** null = página "nova aba" (campo de endereço vazio). */
  activeId: string | null
  /** Pasta do projeto ativo (resolve nome relativo digitado no endereço). */
  cwd: string
  selectTab: (id: string | null) => void
  closeTab: (id: string) => void
  /** A aba passou a mostrar outro alvo (endereço digitado ou navegação no site). */
  navigateTab: (id: string, target: string) => void
  setTitle: (id: string, title: string) => void
  /** O seletor apontou um elemento nesta aba: vira um chip no composer. */
  pick: (tab: PreviewTab, pick: InspectorPick) => void
}

export interface PreviewController {
  open: PreviewOpenApi
  state: PreviewState
}

export interface PreviewControllerOptions {
  /** Mostrar a aba Preview no painel da direita. */
  onReveal: () => void
  /** Elemento escolhido pelo seletor (o App põe nos chips do composer). */
  onPick: (el: PickedElement) => void
  cwd: string
}

const PreviewOpenContext = createContext<PreviewOpenApi | null>(null)
const PreviewStateContext = createContext<PreviewState | null>(null)

export function usePreviewController({ onReveal, onPick, cwd }: PreviewControllerOptions): PreviewController {
  const [tabs, setTabs] = useState<PreviewTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Refs: as ações leem o valor atual sem mudar de identidade a cada render.
  const tabsRef = useRef(tabs)
  const activeRef = useRef(activeId)
  const revealRef = useRef(onReveal)
  const pickRef = useRef(onPick)
  const cwdRef = useRef(cwd)
  revealRef.current = onReveal
  pickRef.current = onPick
  cwdRef.current = cwd

  const commitTabs = useCallback((next: PreviewTab[]) => {
    tabsRef.current = next
    setTabs(next)
  }, [])
  const commitActive = useCallback((id: string | null) => {
    activeRef.current = id
    setActiveId(id)
  }, [])

  const openInPreview = useCallback(
    (raw: string, opts?: OpenOptions): boolean => {
      const fromBase = opts?.base ? resolveRelativeLink(raw, opts.base) : null
      const target = fromBase ?? normalizeTarget(raw, cwdRef.current)
      if (!target) return false
      const key = targetKey(target)
      const hit = tabsRef.current.find((t) => targetKey(t.target) === key)
      if (hit) {
        commitActive(hit.id)
      } else {
        const tab = makeTab(target)
        commitTabs([...tabsRef.current, tab])
        commitActive(tab.id)
      }
      if (opts?.reveal !== false) revealRef.current()
      return true
    },
    [commitActive, commitTabs]
  )

  const closeTab = useCallback(
    (id: string) => {
      const list = tabsRef.current
      const i = list.findIndex((t) => t.id === id)
      if (i < 0) return
      const next = list.filter((t) => t.id !== id)
      commitTabs(next)
      if (activeRef.current === id) commitActive(next[Math.max(0, i - 1)]?.id ?? null)
    },
    [commitActive, commitTabs]
  )

  const navigateTab = useCallback(
    (id: string, target: string) => {
      commitTabs(
        tabsRef.current.map((t) =>
          t.id === id && t.target !== target ? { ...t, target, kind: previewKindFor(target), title: titleFor(target) } : t
        )
      )
    },
    [commitTabs]
  )

  const setTitle = useCallback(
    (id: string, title: string) => {
      const clean = title.trim()
      if (!clean) return
      commitTabs(tabsRef.current.map((t) => (t.id === id && t.title !== clean ? { ...t, title: clean } : t)))
    },
    [commitTabs]
  )

  const pick = useCallback((tab: PreviewTab, p: InspectorPick) => pickRef.current(pickToElement(p, tab)), [])

  const open = useMemo<PreviewOpenApi>(() => ({ openInPreview }), [openInPreview])
  const state = useMemo<PreviewState>(
    () => ({ tabs, activeId, cwd, openInPreview, selectTab: commitActive, closeTab, navigateTab, setTitle, pick }),
    [tabs, activeId, cwd, openInPreview, commitActive, closeTab, navigateTab, setTitle, pick]
  )
  return { open, state }
}

export function PreviewProvider({ controller, children }: { controller: PreviewController; children: ReactNode }): JSX.Element {
  return (
    <PreviewOpenContext.Provider value={controller.open}>
      <PreviewStateContext.Provider value={controller.state}>{children}</PreviewStateContext.Provider>
    </PreviewOpenContext.Provider>
  )
}

/** `openInPreview` para quem está dentro do App; null fora dele (comportamento antigo). */
export function usePreview(): PreviewOpenApi | null {
  return useContext(PreviewOpenContext)
}

/** Estado completo das abas (só o PreviewPane). */
export function usePreviewState(): PreviewState | null {
  return useContext(PreviewStateContext)
}
