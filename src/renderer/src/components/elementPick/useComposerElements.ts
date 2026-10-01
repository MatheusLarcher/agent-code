/**
 * O lado do Composer no "Selecionar" do navegador: cada elemento marcado entra no
 * campo como anexo inline (elementToken.ts) no último ponto do cursor, e os
 * "[elemento N]" são renumerados pela ordem no texto.
 */
import { useEffect, useRef, type RefObject } from 'react'
import type { PickedElement } from '@shared/ipc'
import type { EditorElement } from '../../inlineMedia/InlineEditor'
import type { InlineAtt } from '../../inlineMedia/inlineAttachments'
import { elementsInOrder, makeElementAtt } from './elementToken'

interface MediaApi {
  atts: ReadonlyMap<string, InlineAtt>
  order: readonly string[]
  orderRef: RefObject<readonly string[]>
  version: number
  insertAtt: (att: InlineAtt, at?: number | null) => void
  replaceAtt: (id: string, att: InlineAtt) => void
}

export function useComposerElements(
  media: MediaApi,
  editorRef: RefObject<EditorElement | null>,
  picked: readonly PickedElement[],
  onConsumed: () => void
): void {
  const mediaRef = useRef(media)
  mediaRef.current = media

  // Recém-marcados: vão para o campo e saem da fila do App. Campo travado (sem
  // sessão, pasta sumida) segura a fila até destravar.
  useEffect(() => {
    if (picked.length === 0) return
    const el = editorRef.current
    if (!el || el.disabled || el.readOnly) return
    const m = mediaRef.current
    let n = elementsInOrder(m.orderRef.current ?? [], m.atts).length
    for (const p of picked) m.insertAtt(makeElementAtt(p, ++n))
    onConsumed()
  }, [picked, editorRef, onConsumed])

  // Renumera "[elemento N]" pela ordem no texto.
  useEffect(() => {
    elementsInOrder(media.order, media.atts).forEach((a, i) => {
      if (a.name !== `elemento ${i + 1}`) media.replaceAtt(a.id, makeElementAtt(a.el, i + 1, a.id))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.order, media.version])
}
