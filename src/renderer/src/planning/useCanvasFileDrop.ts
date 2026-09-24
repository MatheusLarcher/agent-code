/**
 * Soltar arquivo e colar imagem no canvas do planejamento: converte o evento
 * do navegador em (arquivos, alvo) e chama `onDropFiles` — as regras ficam no
 * mediaDrop.ts (puro, testado). Precisa estar dentro do ReactFlowProvider.
 *
 * - Drop: o card sob o ponteiro (o nó do React Flow tem data-id) recebe os
 *   anexos; fora de card, o alvo é a coluna e a posição do ponto do drop.
 * - Ctrl+V: só fora de campo de texto, com o canvas na tela e o foco nele ou
 *   em lugar nenhum. O card nasce no meio da parte visível do canvas.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type RefObject } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { PlanLayout } from './layout'
import { dropTargetOf, hasFiles, pasteAllowed, transferFiles, type DropTarget, type DroppedFile } from './mediaDrop'

export interface CanvasFileDrop {
  ref: RefObject<HTMLDivElement | null>
  /** Arrastando arquivo por cima: o canvas mostra onde soltar. */
  dragging: boolean
  handlers: {
    onDragEnter?: (e: DragEvent<HTMLDivElement>) => void
    onDragOver?: (e: DragEvent<HTMLDivElement>) => void
    onDragLeave?: (e: DragEvent<HTMLDivElement>) => void
    onDrop?: (e: DragEvent<HTMLDivElement>) => void
  }
}

export function useCanvasFileDrop(
  layout: PlanLayout,
  onDropFiles: ((files: DroppedFile[], target: DropTarget) => void) | undefined
): CanvasFileDrop {
  const flow = useReactFlow()
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave disparam a cada filho cruzado: conta a profundidade.
  const depth = useRef(0)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const cbRef = useRef(onDropFiles)
  cbRef.current = onDropFiles
  const enabled = !!onDropFiles

  const onDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault()
    depth.current++
    setDragging(true)
  }, [])

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e.dataTransfer)) return
    e.preventDefault() // sem isso o drop não acontece
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e.dataTransfer)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setDragging(false)
  }, [])

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      if (!hasFiles(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()
      depth.current = 0
      setDragging(false)
      const files = transferFiles(e.dataTransfer)
      if (!files.length) return
      const node = (e.target as Element | null)?.closest?.('.react-flow__node')
      const point = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      cbRef.current?.(files, dropTargetOf(layoutRef.current, node?.getAttribute('data-id'), point))
    },
    [flow]
  )

  useEffect(() => {
    if (!enabled) return
    const onPaste = (e: ClipboardEvent): void => {
      const wrap = ref.current
      if (!pasteAllowed(e.target, wrap, !!wrap && wrap.getClientRects().length > 0)) return
      const files = transferFiles(e.clipboardData)
      if (!files.length || !wrap) return // texto colado: não é com o canvas
      e.preventDefault()
      const r = wrap.getBoundingClientRect()
      const point = flow.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 3 })
      cbRef.current?.(files, dropTargetOf(layoutRef.current, null, point))
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [enabled, flow])

  return {
    ref,
    dragging,
    handlers: enabled ? { onDragEnter, onDragOver, onDragLeave, onDrop } : {}
  }
}
