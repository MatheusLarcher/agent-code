/**
 * Anexos do composer: imagens viram JPEG reduzido (o envio pela LAN/relay fica
 * leve); qualquer outro arquivo vai em base64 e o PC salva em disco e passa o
 * caminho ao agente — igual ao composer do desktop.
 */
import type { FileAttachment, ImageAttachment } from '../core/types'

export const MAX_FILE_BYTES = 16 * 1024 * 1024
export const MAX_ATTACHMENTS = 8
const MAX_SIDE = 1600

export function imageToAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const img = new Image()
      img.onload = () => {
        let w = img.width
        let h = img.height
        if (w > MAX_SIDE || h > MAX_SIDE) {
          const scale = MAX_SIDE / Math.max(w, h)
          w = Math.round(w * scale)
          h = Math.round(h * scale)
        }
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d')?.drawImage(img, 0, 0, w, h)
        const m = /^data:([^;]+);base64,(.*)$/.exec(canvas.toDataURL('image/jpeg', 0.85))
        if (m) resolve({ mediaType: m[1], data: m[2] })
        else reject(new Error('imagem inválida'))
      }
      img.onerror = () => reject(new Error('imagem inválida'))
      img.src = String(reader.result)
    }
    reader.onerror = () => reject(new Error('falha ao ler imagem'))
    reader.readAsDataURL(file)
  })
}

export function fileToAttachment(file: File): Promise<FileAttachment> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_FILE_BYTES) return reject(new Error(`${file.name} passa de 16 MB`))
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      const i = s.indexOf('base64,')
      resolve({ name: file.name || 'arquivo', mediaType: file.type || 'application/octet-stream', data: i >= 0 ? s.slice(i + 7) : '', size: file.size })
    }
    r.onerror = () => reject(new Error(`falha ao ler ${file.name}`))
    r.readAsDataURL(file)
  })
}

export function isImage(file: File): boolean {
  return file.type.startsWith('image/')
}
