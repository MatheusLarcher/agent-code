/**
 * Painel da direita inteiro como alvo de soltar arquivo: arrastar do Explorer
 * e soltar em qualquer aba (Quadro, Scrum Master, Preview, inclusive com site
 * aberto) abre o arquivo numa aba do Preview e troca o painel para ela.
 *
 * - Só reage a arraste com 'Files'. O arraste de cartões do Quadro não traz
 *   arquivo e segue para o BoardPanel sem passar por aqui.
 * - Entra/sai por contador de profundidade (dragenter/dragleave disparam a cada
 *   filho que o cursor cruza; relatedTarget não é confiável no Chromium).
 * - O <webview> engole o arraste: o documento do app não recebe dragenter
 *   quando o arquivo entra direto sobre ele. O preload da página avisa
 *   (PREVIEW_INSPECTOR.dragfile), o WebPreview chama `announceFileDrag()` e a
 *   camada aparece por cima, recebendo o drop no lugar da página.
 * - Uma rede de segurança esconde a camada se o arraste sumir sem dragleave.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import { IconPreview } from '../components/Icons'
import { usePreview } from './PreviewContext'
import './preview.css'

/** Evento de janela: arquivo sendo arrastado sobre o webview do Preview. */
export const FILE_DRAG_EVENT = 'agent-preview:file-drag'

/** O webview avisou que há arquivo arrastado sobre ele. */
export function announceFileDrag(): void {
  window.dispatchEvent(new CustomEvent(FILE_DRAG_EVENT))
}

/** Sem dragover por este tempo, o arraste acabou fora de vista: esconde a camada. */
const IDLE_MS = 1200

export const hasFiles = (e: { dataTransfer: DataTransfer | null }): boolean =>
  !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes('Files')

/** Caminhos dos arquivos soltos (o Electron dá o caminho real pelo preload). */
export function droppedPaths(dt: DataTransfer | null): string[] {
  const out: string[] = []
  for (const f of Array.from(dt?.files ?? [])) {
    try {
      const p = window.api?.getPathForFile?.(f)
      if (p) out.push(p)
    } catch {
      // Arquivo sem caminho no disco (ex.: arrastado de outro app): ignora.
    }
  }
  return out
}

interface Props {
  className?: string
  style?: CSSProperties
  children: ReactNode
}

export function RightPaneDrop({ className, style, children }: Props): JSX.Element {
  const preview = usePreview()
  const [active, setActive] = useState(false)
  const depth = useRef(0)
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hide = useCallback((): void => {
    depth.current = 0
    if (idle.current) clearTimeout(idle.current)
    idle.current = null
    setActive(false)
  }, [])

  // Mostra (ou mantém) a camada e rearma a rede de segurança.
  const keepAlive = useCallback((): void => {
    setActive(true)
    if (idle.current) clearTimeout(idle.current)
    idle.current = setTimeout(hide, IDLE_MS)
  }, [hide])

  useEffect(() => {
    if (!preview) return
    // Fim do arraste em qualquer lugar da janela (soltou no chat, Esc…).
    const end = (): void => hide()
    window.addEventListener(FILE_DRAG_EVENT, keepAlive)
    window.addEventListener('drop', end)
    window.addEventListener('dragend', end)
    return () => {
      window.removeEventListener(FILE_DRAG_EVENT, keepAlive)
      window.removeEventListener('drop', end)
      window.removeEventListener('dragend', end)
      if (idle.current) clearTimeout(idle.current)
    }
  }, [preview, keepAlive, hide])

  // Sem Preview (janela solta, teste sem provider): o painel é só o painel.
  if (!preview) {
    return (
      <div className={className} style={style}>
        {children}
      </div>
    )
  }

  const onDragEnter = (e: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth.current += 1
    keepAlive()
  }
  const onDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    keepAlive()
  }
  const onDragLeave = (e: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) hide()
  }
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e)) return
    e.preventDefault()
    e.stopPropagation()
    hide()
    for (const p of droppedPaths(e.dataTransfer)) preview.openInPreview(p)
  }

  return (
    <div
      className={`${className ?? ''} rp-drop-host`.trim()}
      style={style}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      {active && (
        <div className="rp-drop" data-testid="rp-drop" role="status" aria-live="polite">
          <div className="rp-drop-card">
            <IconPreview size={22} aria-hidden="true" />
            <strong>Solte para abrir no Preview</strong>
            <span>Cada arquivo abre numa aba do Preview</span>
          </div>
        </div>
      )}
    </div>
  )
}
