/**
 * Imagens do `agent_code_enviar`: validação na fronteira e a montagem no MESMO
 * formato do anexo no meio do texto do composer (src/shared/inlineMedia.ts).
 *
 * O chamador marca o lugar com `[[imagem:N]]` (N = posição em `imagens`, a
 * partir de 1). Aqui cada marcador vira `{{midia:k}}` — k é a ordem em que a
 * imagem aparece no texto, a mesma regra do composer — e a imagem segue como
 * anexo normal com o rótulo `midia:k = nome`. Imagem sem marcador ganha o dela
 * no fim do texto. Daí em diante nada é diferente de uma imagem colada: a bolha
 * a mostra no lugar e o main a grava onde já grava os anexos da conversa.
 */
import { z } from 'zod'
import type { ImageAttachment } from '../../shared/ipc'
import { MEDIA_MARKER_SOURCE, mediaLabel, mediaMarker } from '../../shared/inlineMedia'

export const MCP_MAX_IMAGES = 4
export const MCP_MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MCP_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type McpImageMime = (typeof MCP_IMAGE_MIMES)[number]

/** Teto do base64 de uma imagem de 5 MB (4/3 do tamanho, arredondado para cima). */
const MAX_BASE64_CHARS = Math.ceil(MCP_MAX_IMAGE_BYTES / 3) * 4

export const McpImageArg = z.strictObject(
  {
    nome: z.string().trim().min(1, 'nome é obrigatório').max(200),
    mime: z.enum(MCP_IMAGE_MIMES, { message: `mime deve ser ${MCP_IMAGE_MIMES.join(', ')}` }),
    base64: z.string().min(1, 'base64 é obrigatório')
  },
  { error: (iss) => (iss.code === 'unrecognized_keys' ? `campo desconhecido: ${iss.keys.join(', ')}` : undefined) }
)
export type McpImageArg = z.infer<typeof McpImageArg>

export const McpImagesArg = z
  .array(McpImageArg)
  .min(1, 'mande ao menos 1 imagem ou omita o campo')
  .max(MCP_MAX_IMAGES, `no máximo ${MCP_MAX_IMAGES} imagens`)

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** O mime que os bytes iniciais dizem (PNG, JPEG, WEBP); null se nenhum dos três. */
export function sniffImageMime(bytes: Uint8Array): McpImageMime | null {
  const b = (i: number): number => bytes[i] ?? -1
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b(i) === v)) return 'image/png'
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg'
  const ascii = (from: number, s: string): boolean => [...s].every((c, i) => b(from + i) === c.charCodeAt(0))
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  return null
}

/** Só o nome do arquivo: sem pasta (de nenhum dos dois sistemas), sem controle. */
export function sanitizeImageName(name: string, n: number): string {
  // eslint-disable-next-line no-control-regex
  const base = (name.split(/[\\/]+/).pop() ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  const clean = base.replace(/^\.+/, '').slice(0, 120).trim()
  return clean || `imagem-${n}`
}

/** Confere uma imagem; devolve o erro legível (com o índice a partir de 1) ou null. */
export function checkImage(img: McpImageArg, n: number): string | null {
  const where = `imagens[${n}] (${sanitizeImageName(img.nome, n)})`
  const b64 = img.base64
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    return `${where}: base64 inválido (sem prefixo "data:", sem espaços nem quebras de linha)`
  }
  if (b64.length > MAX_BASE64_CHARS + 4) return `${where}: passa de 5 MB`
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length === 0) return `${where}: imagem vazia`
  if (bytes.length > MCP_MAX_IMAGE_BYTES) return `${where}: passa de 5 MB (${bytes.length} bytes)`
  const real = sniffImageMime(bytes)
  if (!real) return `${where}: os bytes não são PNG, JPEG nem WEBP`
  if (real !== img.mime) return `${where}: mime diz ${img.mime}, mas os bytes são ${real}`
  return null
}

const CALLER_MARKER_SOURCE = '\\[\\[imagem:(\\d{1,4})\\]\\]'

export interface McpImageMessage {
  /** O texto que vai ao agente, com `{{midia:k}}` no lugar de cada imagem. */
  text: string
  /** As imagens na ordem k, cada uma com o rótulo `midia:k = nome`. */
  images: ImageAttachment[]
}

/**
 * Prompt + imagens (já validadas) → mensagem no formato do composer. Erro de
 * validação (marcador sem imagem, marcador do app escrito à mão) volta como
 * `{ erro }`. Sem imagens nem marcadores, o prompt sai idêntico.
 */
export function buildImageMessage(prompt: string, imgs: readonly McpImageArg[]): McpImageMessage | { erro: string } {
  if (new RegExp(MEDIA_MARKER_SOURCE).test(prompt) && imgs.length > 0) {
    return { erro: 'prompt: marque as imagens com [[imagem:N]]; {{midia:N}} é de uso interno do Agent Code' }
  }
  const missing = new Set<string>()
  for (const m of prompt.matchAll(new RegExp(CALLER_MARKER_SOURCE, 'g'))) {
    const n = Number(m[1])
    if (n < 1 || n > imgs.length) missing.add(m[0])
  }
  if (missing.size > 0) {
    const vieram = imgs.length === 0 ? 'nenhuma imagem veio' : `vieram ${imgs.length} imagem(ns)`
    return { erro: `prompt: ${[...missing].join(', ')} sem imagem correspondente (${vieram}; N começa em 1)` }
  }
  if (imgs.length === 0) return { text: prompt, images: [] }

  const slotOf = new Map<number, number>() // índice em imgs (1..) → k no texto
  const images: ImageAttachment[] = []
  const place = (n: number): string => {
    let k = slotOf.get(n)
    if (k === undefined) {
      k = images.length + 1
      slotOf.set(n, k)
      const img = imgs[n - 1]
      images.push({ mediaType: img.mime, data: img.base64, label: mediaLabel(k, sanitizeImageName(img.nome, n)) })
    }
    return mediaMarker(k)
  }
  let text = prompt.replace(new RegExp(CALLER_MARKER_SOURCE, 'g'), (_m, n: string) => place(Number(n)))
  const tail: string[] = []
  for (let n = 1; n <= imgs.length; n++) if (!slotOf.has(n)) tail.push(place(n))
  if (tail.length > 0) text = `${text}\n\n${tail.join(' ')}`
  return { text, images }
}
