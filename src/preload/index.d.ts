import type { AgentCodeApi } from './index'

declare global {
  interface Window {
    api: AgentCodeApi
  }
}

export {}
