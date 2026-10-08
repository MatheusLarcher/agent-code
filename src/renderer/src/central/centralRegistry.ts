/**
 * Registro da Central no renderer: os campos com que ela nasce, a lista de
 * entradas (pedidos, respostas espelhadas, perguntas) e a validação do que
 * volta do banco. Puro, fora do App.tsx, para ser testável sem montar a janela.
 *
 * A Central guarda só o que é leve: texto e NOMES de anexos. Os bytes de um
 * pedido ficam em memória, pelo id da entrada (ver centralSend.ts).
 */
import type { FileAttachment, FileRefAttachment, ImageAttachment } from '@shared/ipc'
import {
  CENTRAL_TITLE,
  MAX_CENTRAL_ENTRIES,
  type CentralEntry,
  type CentralRequestEntry,
  type CentralState
} from '@shared/central'
import { mediaLabelNumber, sanitizeMediaLabel } from '@shared/inlineMedia'
import type { Conversation } from '../types'

/** Os campos da conversa que É a Central (o id e a pasta vazia vêm de quem cria). */
export function centralConversationFields(): Partial<Conversation> {
  return {
    title: CENTRAL_TITLE,
    // Título travado: nada automático (recuo, LLM) renomeia a Central.
    titleSource: 'user',
    mode: 'central',
    central: { entries: [] },
    fastMode: false
  }
}

/** Acrescenta uma entrada e corta no teto, ficando com as mais novas. */
export function appendCentralEntry(state: CentralState | undefined, entry: CentralEntry): CentralState {
  const entries = Array.isArray(state?.entries) ? state.entries : []
  return { entries: [...entries, entry].slice(-MAX_CENTRAL_ENTRIES) }
}

// Sequência da sessão: dois pedidos no mesmo milissegundo não colidem.
let requestSeq = 0

/** Um pedido novo, ainda decidindo o destino. */
export function newCentralRequest(text: string, attachments: string[], now: number = Date.now()): CentralRequestEntry {
  requestSeq += 1
  const id = `req-${now.toString(36)}-${requestSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  return {
    kind: 'request',
    id,
    ts: now,
    text,
    ...(attachments.length ? { attachments: [...attachments] } : {}),
    state: 'routing'
  }
}

/* ---- validação do payload: a mesma da fila de gravação (@shared/centralMerge) ---- */

export { normalizeCentralState } from '@shared/centralMerge'

/* ---- anexos ---- */

/** O nome de um rótulo `midia:N = nome` (vazio sem rótulo válido). */
function labelName(label: unknown): string {
  const ok = sanitizeMediaLabel(label)
  return ok ? ok.slice(ok.indexOf(' = ') + 3) : ''
}

/** Os NOMES dos anexos de um envio, na ordem dos `{{midia:N}}` do texto (sem
 *  rótulo, como a imagem vinda do celular, vão depois, na ordem em que vieram). */
export function centralAttachmentNames(
  images: readonly ImageAttachment[],
  files: readonly FileAttachment[],
  fileRefs: readonly FileRefAttachment[]
): string[] {
  const all = [
    ...images.map((a) => ({ label: a.label, name: labelName(a.label) || 'imagem' })),
    ...files.map((a) => ({ label: a.label, name: a.name })),
    ...fileRefs.map((a) => ({ label: a.label, name: a.name }))
  ]
  return all
    .map((a, i) => ({ name: a.name, i, n: mediaLabelNumber(a.label) }))
    .sort((a, b) => (a.n ?? Infinity) - (b.n ?? Infinity) || a.i - b.i)
    .map((a) => a.name)
}
