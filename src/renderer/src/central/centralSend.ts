/**
 * Envio na Central: o pedido vira uma entrada "routing" na própria Central e vai
 * para o roteador. Nunca passa pelo `dispatch` do App — a Central não sobe
 * sessão de agente; quem recebe a mensagem é a conversa do assunto (Etapa 5).
 *
 * Só o que é leve vai para o payload da Central (texto + NOMES dos anexos). Os
 * bytes ficam em memória pelo id da entrada, até o roteador entregá-los.
 */
import { useCallback, useRef, type MutableRefObject } from 'react'
import type { FileAttachment, FileRefAttachment, ImageAttachment } from '@shared/ipc'
import { CENTRAL_ID, type CentralRequestEntry } from '@shared/central'
import type { Conversation } from '../types'
import { appendCentralEntry, centralAttachmentNames, newCentralRequest } from './centralRegistry'

/** O aviso da Central quando falta o TypeSafe (o do modo Automático é outro). */
export const CENTRAL_TYPESAFE_MESSAGE = 'Ative o TypeSafe e informe a API key nas Configurações para usar a Central.'

/** Tudo o que o usuário mandou num pedido — o que o roteador entrega no destino. */
export interface CentralPayload {
  text: string
  images: ImageAttachment[]
  /** Miniaturas (data: URL) para a bolha no destino. */
  thumbs: string[]
  files: FileAttachment[]
  fileRefs: FileRefAttachment[]
}

/** Onde o pedido entraria no roteamento sem `deps.route`: nada. Quem roteia é o
 *  `useCentral` (centralDelivery.ts), que passa o `route` dele. */
export function routeCentralRequest(_entryId: string, _payload: CentralPayload): void {}

export interface CentralSendDeps {
  /** TypeSafe ligado e com key. */
  typesafeReady: boolean
  /** O mesmo fluxo do modo Automático: aviso + Configurações no TypeSafe. */
  needTypesafe: () => void
  /** A Central na tela (o boot pode ainda estar lendo, ex.: celular logo na abertura). */
  ensure: () => Promise<Conversation | null>
  patchConv: (id: string, fn: (c: Conversation) => Conversation) => void
  /** Aviso quando a Central não pôde ser carregada. */
  notifyError: (msg: string) => void
  route?: (entryId: string, payload: CentralPayload) => void
  /** `installationId` deste PC: o dono do pedido na Central (os dois PCs a dividem). */
  device?: string
}

/** De onde veio o pedido: do campo da Central ou do celular. */
export type CentralSendOrigin = 'composer' | 'phone'

export type CentralSend = (
  text: string,
  images: ImageAttachment[],
  thumbs: string[],
  files: FileAttachment[],
  fileRefs: FileRefAttachment[],
  origin?: CentralSendOrigin
) => Promise<boolean>

/**
 * O envio da Central. Devolve se o pedido entrou (false = nada registrado).
 * Sem TypeSafe: o gate roda sempre; do campo, nada é registrado (o texto fica
 * lá para mandar depois); do celular, o pedido entra mesmo assim — lá não há
 * campo no PC para segurá-lo, e mensagem nenhuma se perde.
 */
export function useCentralSend(deps: CentralSendDeps): {
  send: CentralSend
  payloads: MutableRefObject<Map<string, CentralPayload>>
} {
  const depsRef = useRef(deps)
  depsRef.current = deps
  const payloads = useRef(new Map<string, CentralPayload>())
  const send = useCallback<CentralSend>(async (text, images, thumbs, files, fileRefs, origin = 'composer') => {
    const d = depsRef.current
    if (!text.trim() && images.length === 0 && files.length === 0 && fileRefs.length === 0) return false
    if (!d.typesafeReady) {
      d.needTypesafe()
      if (origin === 'composer') return false
    }
    const central = await d.ensure()
    if (!central) {
      d.notifyError('A Central ainda não carregou. Tente de novo em instantes.')
      return false
    }
    const entry: CentralRequestEntry = {
      ...newCentralRequest(text, centralAttachmentNames(images, files, fileRefs)),
      origin: 'central',
      ...(d.device ? { device: d.device } : {})
    }
    const payload: CentralPayload = { text, images, thumbs, files, fileRefs }
    payloads.current.set(entry.id, payload)
    d.patchConv(CENTRAL_ID, (c) => ({ ...c, central: appendCentralEntry(c.central, entry), updatedAt: entry.ts }))
    ;(d.route ?? routeCentralRequest)(entry.id, payload)
    return true
  }, [])
  return { send, payloads }
}
