/**
 * Chamado novo do agente (app_chamar_usuario): o HTML dele abre também numa aba
 * do Preview. Na aba Conversa o Preview vem para a frente; no Escritório a TV
 * da sala já mostra, então a aba só fica aberta esperando.
 */
import { useEffect, useRef } from 'react'
import { onNewOfficeCall } from '../office3d/useOfficeCalls'
import type { PreviewOpenApi } from './PreviewContext'

export function usePreviewOfficeCalls(open: PreviewOpenApi, shouldReveal: () => boolean): void {
  const revealRef = useRef(shouldReveal)
  revealRef.current = shouldReveal
  useEffect(
    () => onNewOfficeCall((call) => void open.openInPreview(call.path, { reveal: revealRef.current() })),
    [open]
  )
}
