/**
 * Baixar um arquivo entregue pelo agente (`/api/file` da ponte).
 *
 * No APK, um `<a download>` apontando para o PC NÃO baixa: o Capacitor externaliza
 * navegação para outro host, então o toque saía do app e abria o Chrome — medido
 * no emulador, nada chegava em Downloads. Com a ponte nativa (`AgentDownload`, do
 * MainActivity) o caminho é uma CHAMADA: a URL vai direto ao DownloadManager. No
 * navegador comum segue valendo o `<a download>`.
 */
import { basename } from './format'

export function triggerDownload(url: string, path: string): void {
  const name = basename(path)
  const native = window.AgentDownload
  if (native && typeof native.enqueue === 'function') {
    try {
      native.enqueue(url, name)
      return
    } catch {
      /* cai no link abaixo */
    }
  }
  const a = document.createElement('a')
  a.href = url
  a.setAttribute('download', name)
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  setTimeout(() => a.remove(), 0)
}
