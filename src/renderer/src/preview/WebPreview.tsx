/**
 * O <webview> do Preview: sites (http/https) e arquivos que o Chromium mostra
 * sozinho (html, svg, imagem, pdf, vídeo, áudio — via agent-preview://).
 *
 * Roda numa sessão separada (PREVIEW_PARTITION), sem pop-ups. Conversa com o
 * seletor de elementos (preload do guest, outra tarefa) pelos canais
 * PREVIEW_INSPECTOR: liga/desliga com `send(toggle, bool)` e recebe ready,
 * picked e esc por `ipc-message`.
 */
import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { PREVIEW_INSPECTOR, PREVIEW_PARTITION, type InspectorPick } from '@shared/preview'
import { IconRefresh } from '../components/Icons'
import { marksForTab, subscribeComposerElements } from './composerElements'
import { announceFileDrag } from './RightPaneDrop'

/** Os métodos do <webview> do Electron que o Preview usa (todos opcionais: no teste não existem). */
interface WebviewEl extends HTMLElement {
  send?: (channel: string, ...args: unknown[]) => Promise<void> | void
  goBack?: () => void
  goForward?: () => void
  reload?: () => void
  canGoBack?: () => boolean
  canGoForward?: () => boolean
  loadURL?: (url: string) => Promise<void>
  insertCSS?: (css: string) => Promise<string>
}

/**
 * Barra de rolagem fina e discreta em toda página do Preview, no lugar da
 * nativa do Windows (regra do app: nada de controle nativo). Só a aparência:
 * a página continua rolando igual.
 */
export const PREVIEW_SCROLLBAR_CSS = `
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(128,128,128,.45); border-radius: 6px; border: 2px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background-color: rgba(128,128,128,.7); }
::-webkit-scrollbar-button { display: none; }
`

export interface WebControls {
  back: () => void
  forward: () => void
  reload: () => void
}

export interface NavState {
  canBack: boolean
  canForward: boolean
}

export interface WebHooks {
  /** Modo seleção ligado (botão Selecionar). */
  picking: boolean
  onPickingChange: (on: boolean) => void
  onPick: (pick: InspectorPick) => void
  onNavigate: (url: string) => void
  onTitle: (title: string) => void
  onNavState: (s: NavState) => void
  /** Voltar/avançar/recarregar da barra do Preview. */
  controlRef: MutableRefObject<WebControls | null>
  /** Aba do Preview: a página só mantém marcados os elementos desta aba que estão no campo de mensagem. */
  tabId?: string
}

interface Props extends WebHooks {
  src: string
  /** Aba de site: a navegação dentro da página muda o endereço da aba. */
  followNav: boolean
}

/** Chama um método do guest sem quebrar se ele ainda não carregou. */
function safeSend(wv: WebviewEl | null, channel: string, ...args: unknown[]): void {
  try {
    Promise.resolve(wv?.send?.(channel, ...args)).catch(() => {})
  } catch {
    // Antes do dom-ready o send lança — o "ready" do guest reenvia depois.
  }
}

export function WebPreview({ src, followNav, ...hooks }: Props): JSX.Element {
  const ref = useRef<WebviewEl | null>(null)
  // O src do elemento fica fixo: trocar o atributo recarregaria a página a cada
  // navegação que a própria página fez. Endereço novo de fora vai por loadURL.
  const [initialSrc] = useState(src)
  const currentUrl = useRef(src)
  const ready = useRef(false)
  const hooksRef = useRef(hooks)
  hooksRef.current = hooks
  const followRef = useRef(followNav)
  followRef.current = followNav
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const navState = (): void => {
      try {
        hooksRef.current.onNavState({ canBack: !!wv.canGoBack?.(), canForward: !!wv.canGoForward?.() })
      } catch {
        // Ainda sem página carregada.
      }
    }
    const onNav = (e: Event): void => {
      // Âncora/pushState dentro de um iframe da página: não é o endereço da aba.
      if ((e as Event & { isMainFrame?: boolean }).isMainFrame === false) return
      const url = (e as Event & { url?: string }).url
      if (url) currentUrl.current = url
      if (url && followRef.current && /^https?:\/\//i.test(url)) hooksRef.current.onNavigate(url)
      navState()
    }
    const onTitle = (e: Event): void => hooksRef.current.onTitle((e as Event & { title?: string }).title ?? '')
    const onStart = (): void => {
      setLoading(true)
      setFailure(null)
    }
    const onStop = (): void => setLoading(false)
    const onDomReady = (): void => {
      ready.current = true
      try {
        Promise.resolve(wv.insertCSS?.(PREVIEW_SCROLLBAR_CSS)).catch(() => {})
      } catch {
        // Sem guest (teste) ou página fechando: fica a barra da própria página.
      }
      safeSend(wv, PREVIEW_INSPECTOR.toggle, hooksRef.current.picking)
      navState()
    }
    const onFail = (e: Event): void => {
      const f = e as Event & { errorCode?: number; errorDescription?: string; validatedURL?: string; isMainFrame?: boolean }
      // -3 = navegação cancelada (outra começou por cima): não é erro.
      if (f.errorCode === -3 || f.isMainFrame === false) return
      setLoading(false)
      setFailure(
        `A página ${f.validatedURL || ''} não abriu${f.errorDescription ? ` (${f.errorDescription})` : ''}. Confira o endereço e a internet e tente de novo.`
      )
    }
    const onIpc = (e: Event): void => {
      const m = e as Event & { channel?: string; args?: unknown[] }
      if (m.channel === PREVIEW_INSPECTOR.ready) safeSend(wv, PREVIEW_INSPECTOR.toggle, hooksRef.current.picking)
      else if (m.channel === PREVIEW_INSPECTOR.esc) hooksRef.current.onPickingChange(false)
      else if (m.channel === PREVIEW_INSPECTOR.picked && m.args?.[0]) hooksRef.current.onPick(m.args[0] as InspectorPick)
      // Arquivo arrastado sobre a página: o painel mostra a camada de soltar por cima.
      else if (m.channel === PREVIEW_INSPECTOR.dragfile) announceFileDrag()
    }
    const events: [string, (e: Event) => void][] = [
      ['did-navigate', onNav],
      ['did-navigate-in-page', onNav],
      ['page-title-updated', onTitle],
      ['did-start-loading', onStart],
      ['did-stop-loading', onStop],
      ['dom-ready', onDomReady],
      ['did-fail-load', onFail],
      ['ipc-message', onIpc]
    ]
    for (const [name, fn] of events) wv.addEventListener(name, fn)
    hooksRef.current.controlRef.current = {
      back: () => wv.goBack?.(),
      forward: () => wv.goForward?.(),
      reload: () => {
        setFailure(null)
        wv.reload?.()
      }
    }
    const control = hooksRef.current.controlRef
    return () => {
      for (const [name, fn] of events) wv.removeEventListener(name, fn)
      control.current = null
    }
  }, [])

  // Endereço novo vindo da barra (não da própria página): carrega no mesmo webview.
  useEffect(() => {
    if (src === currentUrl.current) return
    currentUrl.current = src
    setFailure(null)
    try {
      Promise.resolve(ref.current?.loadURL?.(src)).catch(() => {})
    } catch {
      // Ainda sem dom-ready: o src inicial segue valendo.
    }
  }, [src])

  // Botão Selecionar: liga/desliga o seletor na página.
  useEffect(() => {
    if (ready.current) safeSend(ref.current, PREVIEW_INSPECTOR.toggle, hooks.picking)
  }, [hooks.picking])

  // Marca na página = elemento no campo de mensagem: saiu de lá (apagado ou
  // enviado), a marca some; os que ficam seguem o número do "[elemento N]".
  const tabId = hooks.tabId
  useEffect(() => {
    if (!tabId) return
    const push = (els: Parameters<typeof marksForTab>[0]): void => {
      if (ready.current) safeSend(ref.current, PREVIEW_INSPECTOR.sync, marksForTab(els, tabId))
    }
    return subscribeComposerElements(push)
  }, [tabId])

  return (
    <div className={`pp-web${hooks.picking ? ' picking' : ''}`}>
      {loading && !failure && <div className="pp-loadbar" aria-hidden="true" />}
      <webview ref={ref} className="pp-webview" src={initialSrc} partition={PREVIEW_PARTITION} />
      {failure && (
        <div className="pp-notice pp-notice-over" role="alert">
          <strong>A página não carregou</strong>
          <p>{failure}</p>
          <button type="button" className="pp-btn" onClick={() => hooksRef.current.controlRef.current?.reload()}>
            <IconRefresh size={13} aria-hidden="true" />
            Tentar de novo
          </button>
        </div>
      )}
    </div>
  )
}
