import type {
  BrowserFrame,
  BrowserInput,
  BrowserState,
  ChatEvent,
  PermissionRequest,
  PermissionResponse,
  PickedElement,
  StartAgentOptions
} from './ipc'

/** The surface exposed on `window.api` by the preload script. */
export interface AgentCodeApi {
  pickDirectory(): Promise<string | null>

  startAgent(opts: StartAgentOptions): Promise<{ ok: boolean }>
  sendMessage(text: string): Promise<void>
  interrupt(): Promise<void>
  /** Toggle "allow all" on a running session. */
  setBypass(on: boolean): Promise<void>
  respondPermission(res: PermissionResponse): Promise<void>
  onAgentEvent(cb: (e: ChatEvent) => void): () => void
  onPermissionRequest(cb: (r: PermissionRequest) => void): () => void

  launchBrowser(): Promise<void>
  navigate(url: string): Promise<string>
  browserBack(): Promise<void>
  browserForward(): Promise<void>
  browserReload(): Promise<void>
  setSelectMode(on: boolean): Promise<void>
  sendBrowserInput(ev: BrowserInput): Promise<void>
  closeBrowser(): Promise<void>
  onBrowserFrame(cb: (f: BrowserFrame) => void): () => void
  onBrowserState(cb: (s: BrowserState) => void): () => void
  onBrowserPicked(cb: (el: PickedElement) => void): () => void
}
