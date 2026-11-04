import type { FileAttachment, ImageAttachment } from '@shared/ipc'

/** Leitura de File do campo (colar/arrastar/anexar) em memória, com teto de tempo. */

/** Caminho do arquivo no disco (escolhido/arrastado); '' para print colado. */
export function diskPath(file: File): string {
  try {
    return window.api.getPathForFile(file) || ''
  } catch {
    return ''
  }
}

/**
 * Teto para a leitura de um File em memória. Um arquivo real (até 25 MB) lê em
 * fração de segundo; só estoura quando o FileReader PENDURA — p.ex. uma PASTA
 * cujo caminho não foi reconhecido escorrega para cá e, no Windows/Electron,
 * `readAsDataURL` numa pasta pode não disparar `onload` NEM `onerror`. Sem este
 * teto o item ficava "resolvendo" para sempre e travava o envio inteiro.
 */
const READ_TIMEOUT_MS = 30_000

/** Lê o File como data URL, com teto de tempo e `abort`: nunca pendura. */
function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    let done = false
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      try {
        reader.abort()
      } catch {
        // abort pode lançar se já terminou — ignora
      }
      finish(() => reject(new Error('Tempo esgotado ao ler o arquivo (pode ser uma pasta sem caminho).')))
    }, READ_TIMEOUT_MS)
    reader.onload = () => finish(() => resolve(String(reader.result)))
    reader.onerror = () => finish(() => reject(reader.error ?? new Error('Falha ao ler o arquivo.')))
    reader.onabort = () => finish(() => reject(new Error('Leitura do arquivo cancelada.')))
    try {
      reader.readAsDataURL(file)
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))))
    }
  })
}

/** Read an image File as a base64 attachment (strips the data-URL prefix). */
export async function fileToAttachment(file: File): Promise<ImageAttachment> {
  const m = /^data:([^;]+);base64,(.*)$/.exec(await readDataUrl(file))
  if (!m) throw new Error('imagem inválida')
  return { mediaType: m[1], data: m[2] }
}

/** Read any file as a base64 FileAttachment (keeps name/type/size for the chip). */
export async function fileToFileAttachment(file: File): Promise<FileAttachment> {
  const m = /^data:([^;]*);base64,(.*)$/.exec(await readDataUrl(file))
  return {
    name: file.name || 'arquivo',
    mediaType: m?.[1] || file.type || 'application/octet-stream',
    data: m?.[2] || '',
    size: file.size
  }
}
