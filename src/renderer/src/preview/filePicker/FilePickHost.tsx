/**
 * Envolve um visualizador de arquivo com o modo Selecionar do Preview: a área
 * que rola (.pp-file) é a raiz do inspetor e uma camada por cima, recortada
 * pela mesma área, desenha hover e marcas (nada passa por cima do composer
 * ou de outros painéis).
 *
 * As marcas seguem o campo de mensagem, como no <webview> (WebPreview.tsx):
 * só fica marcado o que está lá, com o número do "[elemento N]".
 */
import { useEffect, useRef, type ReactNode } from 'react'
import type { InspectorPick } from '@shared/preview'
import { marksForTab, subscribeComposerElements } from '../composerElements'
import { createRootInspector, type RootInspector } from './rootInspector'
import './filePicker.css'

interface Props {
  /** Modo seleção ligado (botão Selecionar). */
  picking: boolean
  onPickingChange: (on: boolean) => void
  onPick: (pick: InspectorPick) => void
  /** Vai no `url` de cada elemento escolhido (o caminho do arquivo). */
  url: string
  tabId?: string
  children: ReactNode
}

export function FilePickHost({ picking, onPickingChange, onPick, url, tabId, children }: Props): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const layerRef = useRef<HTMLDivElement | null>(null)
  const inspRef = useRef<RootInspector | null>(null)
  const cb = useRef({ onPickingChange, onPick, url })
  cb.current = { onPickingChange, onPick, url }

  useEffect(() => {
    const root = rootRef.current
    const layer = layerRef.current
    if (!root || !layer) return
    const insp = createRootInspector({
      root,
      layer,
      onPick: (p) => cb.current.onPick({ ...p, url: cb.current.url }),
      onEsc: () => cb.current.onPickingChange(false)
    })
    inspRef.current = insp
    return () => {
      insp.destroy()
      inspRef.current = null
    }
  }, [])

  useEffect(() => {
    inspRef.current?.setOn(picking)
  }, [picking])

  useEffect(() => {
    if (!tabId) return
    return subscribeComposerElements((els) => inspRef.current?.sync(marksForTab(els, tabId)))
  }, [tabId])

  return (
    <div className={`pv-pick-host${picking ? ' picking' : ''}`}>
      <div className="pp-file" ref={rootRef} tabIndex={-1}>
        {children}
      </div>
      <div className="pv-pick-layer" ref={layerRef} aria-hidden="true" />
    </div>
  )
}
