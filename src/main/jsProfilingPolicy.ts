// Liga o JS Self-Profiling (`new Profiler(...)`) na janela principal. O
// long-animation-frame só atribui scripts da mesma origem, e o renderer
// instalado carrega por file:// (origem opaca) — os quadros longos chegam sem
// scripts. Com `Document-Policy: js-profiling` na resposta do index.html, o
// renderer consegue amostrar a pilha e o detector (renderer/perf/jsProfiler.ts)
// diz qual função travou a tela.
//
// O Electron aceita UM listener de onHeadersReceived por sessão: o filtro
// file:///* deixa de fora o navegador embutido, e qualquer resposta que não
// seja o mainFrame do index do renderer passa inalterada.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** O pedaço da Session usado aqui (o teste passa uma falsa). */
export interface HeadersSession {
  webRequest: {
    onHeadersReceived(
      filter: { urls: string[] },
      listener: (
        details: { url: string; resourceType: string; responseHeaders?: Record<string, string[]> },
        callback: (response: { responseHeaders?: Record<string, string[]> }) => void
      ) => void
    ): void
  }
}

/** Compara a URL file:// com o caminho do index.html (Windows: sem diferenciar maiúsculas). */
export function rendererIndexMatcher(indexPath: string, platform: NodeJS.Platform = process.platform): (url: string) => boolean {
  const norm = (p: string): string => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
  const target = norm(indexPath)
  return (url) => {
    try {
      return norm(fileURLToPath(url)) === target
    } catch {
      return false
    }
  }
}

/** Acrescenta `Document-Policy: js-profiling` só na resposta mainFrame do index do renderer. */
export function installJsProfilingPolicy(session: HeadersSession, isRendererIndex: (url: string) => boolean): void {
  session.webRequest.onHeadersReceived({ urls: ['file:///*'] }, (details, callback) => {
    let matches = false
    try {
      matches = details.resourceType === 'mainFrame' && isRendererIndex(details.url)
    } catch {
      matches = false
    }
    if (!matches) {
      callback({})
      return
    }
    callback({ responseHeaders: { ...(details.responseHeaders ?? {}), 'Document-Policy': ['js-profiling'] } })
  })
}
