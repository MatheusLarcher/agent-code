/// <reference types="vite/client" />
import type * as React from 'react'

/** O que o WebView do APK põe na janela: a ponte nativa do Capacitor (native-bridge,
 *  injetada pelo Android, sem @capacitor/core no bundle) e o download do MainActivity. */
export interface CapacitorBridge {
  nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>
  addListener?: (plugin: string, event: string, cb: (data: unknown) => void) => unknown
  PluginHeaders?: Array<{ name?: string }>
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

declare global {
  interface Window {
    Capacitor?: CapacitorBridge
    /** MainActivity.java (buildApk.ts): salva em Downloads pelo DownloadManager. */
    AgentDownload?: { enqueue: (url: string, fileName: string) => void }
    webkitAudioContext?: typeof AudioContext
  }
  // React 19 moved the global JSX namespace under React (same as the renderer's env.d.ts).
  namespace JSX {
    type Element = React.JSX.Element
    type IntrinsicElements = React.JSX.IntrinsicElements
  }
}

export {}
