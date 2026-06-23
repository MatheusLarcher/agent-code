import type { Page, CDPSession } from 'playwright'
import type { AndroidDevice } from './android/androidDevice'
import type { BrowserState, TabKind } from '../shared/ipc'

export const DEFAULT_VIEWPORT = { width: 1280, height: 800 }
// Render at 2× and stream higher-quality JPEG so text stays crisp on any display
// DPR (the frame is downscaled into the panel). MAX_FRAME caps a very large panel
// so the JPEGs don't explode in size.
export const DEVICE_SCALE = 2
export const JPEG_QUALITY = 90
export const MAX_FRAME = { width: 3840, height: 2400 }

/**
 * A live preview tab. A `web` tab is backed by a Playwright page + CDP screencast;
 * an `android` tab is backed by an AndroidDevice (emulator/phone) streamed via adb.
 * Exactly one of `page`/`device` is set, per `kind`.
 */
export interface Tab {
  id: string
  kind: TabKind
  page: Page | null
  cdp: CDPSession | null
  device: AndroidDevice | null
  /** Cached so emitState() is synchronous (titles are async to read). */
  title: string
  url: string
  /** True while the page is navigating/loading (drives the toolbar spinner). */
  loading: boolean
}

export const isAndroid = (t: Tab): boolean => t.kind === 'android'

export const EMPTY_STATE: BrowserState = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  launched: false,
  tabs: []
}

let tabCounter = 0
export const nextTabId = (): string => `t${(++tabCounter).toString(36)}-${Date.now().toString(36)}`
