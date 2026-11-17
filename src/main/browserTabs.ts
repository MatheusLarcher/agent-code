import type { Page } from 'playwright'

/** Tamanho da página só nos testes (headless); no app a página segue a janela do Chrome. */
export const TEST_VIEWPORT = { width: 1280, height: 800 }

/** Uma aba real da janela do Chrome do agente. */
export interface Tab {
  id: string
  kind: 'web'
  page: Page
  /** Em cache para a listagem ser síncrona (ler o título é assíncrono). */
  title: string
  url: string
}

let tabCounter = 0
export const nextTabId = (): string => `t${(++tabCounter).toString(36)}-${Date.now().toString(36)}`
