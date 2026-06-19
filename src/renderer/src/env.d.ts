/// <reference types="vite/client" />
import type { AgentCodeApi } from '@shared/api'
import type * as React from 'react'

declare global {
  interface Window {
    api: AgentCodeApi
  }
  // Provide the global JSX namespace (React 19 moved it under React).
  namespace JSX {
    type Element = React.JSX.Element
    type IntrinsicElements = React.JSX.IntrinsicElements
  }
}

export {}
