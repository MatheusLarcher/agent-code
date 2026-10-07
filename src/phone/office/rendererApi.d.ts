import type { AgentCodeApi } from '@shared/api'

/**
 * O escritório do PC (src/renderer/src/office3d) usa o window.api do preload do
 * Electron — sempre conferindo se cada função existe antes de chamar. No celular
 * só há o que a ponte serve (bridgeApi.ts); o tipo é o do PC para o
 * código compartilhado compilar igual.
 */
declare global {
  interface Window {
    api: AgentCodeApi
  }
}

export {}
