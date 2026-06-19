// Shared IPC contract between the Electron main process and the renderer.
// Keep this file type-only so it can be imported from main, preload and renderer.

/** A normalized chat event the renderer renders. Produced in main from SDKMessage. */
export type ChatEvent =
  | { kind: 'system'; sessionId: string; model: string; cwd: string; tools: string[] }
  | { kind: 'assistant-text'; id: string; text: string; final: boolean }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: unknown; parentToolUseId: string | null }
  | { kind: 'tool-result'; id: string; toolUseId: string; isError: boolean; text: string }
  | {
      kind: 'result'
      id: string
      isError: boolean
      text: string
      durationMs: number
      costUsd?: number
      usage?: TokenUsage
    }
  | { kind: 'status'; id: string; text: string }
  | { kind: 'error'; id: string; text: string }

/** Agent asks the user to approve a tool call. */
export interface PermissionRequest {
  id: string
  toolName: string
  input: Record<string, unknown>
}

export interface PermissionResponse {
  id: string
  behavior: 'allow' | 'deny'
  /** When true, remember the decision for this tool name for the rest of the session. */
  always?: boolean
  message?: string
}

/** A live frame from the embedded Playwright browser (CDP screencast). */
export interface BrowserFrame {
  /** base64-encoded JPEG (no data: prefix). */
  data: string
  /** Natural pixel size of the captured page. */
  width: number
  height: number
}

export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  launched: boolean
}

/** Element captured by the "select on page" picker, forwarded to the chat composer. */
export interface PickedElement {
  selector: string
  tagName: string
  id: string
  classes: string
  text: string
  html: string
  url: string
}

/** Input event forwarded from the renderer canvas back into the page. */
export type BrowserInput =
  | { type: 'move'; nx: number; ny: number }
  | { type: 'click'; nx: number; ny: number; button: 'left' | 'right' | 'middle' }
  | { type: 'wheel'; nx: number; ny: number; dx: number; dy: number }
  | { type: 'key'; key: string; text?: string }

/** Per-turn token usage reported by the agent. */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface StartAgentOptions {
  cwd: string
  model?: string
  /** Start the agent with permission prompts disabled (--dangerously-skip-permissions). */
  skipPermissions?: boolean
}

// Channel name constants — single source of truth.
export const Channels = {
  // renderer -> main (invoke)
  agentStart: 'agent:start',
  agentSend: 'agent:send',
  agentInterrupt: 'agent:interrupt',
  agentSetBypass: 'agent:set-bypass',
  agentPermissionResponse: 'agent:permission-response',
  pickDirectory: 'app:pick-directory',
  browserLaunch: 'browser:launch',
  browserNavigate: 'browser:navigate',
  browserBack: 'browser:back',
  browserForward: 'browser:forward',
  browserReload: 'browser:reload',
  browserSetSelectMode: 'browser:set-select-mode',
  browserInput: 'browser:input',
  browserClose: 'browser:close',
  // main -> renderer (send)
  agentEvent: 'agent:event',
  agentPermissionRequest: 'agent:permission-request',
  browserFrame: 'browser:frame',
  browserStateChanged: 'browser:state',
  browserPicked: 'browser:picked'
} as const
