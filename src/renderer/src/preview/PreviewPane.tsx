/**
 * Conteúdo da aba Preview do painel da direita: abas internas, barra de
 * endereço e a área que mostra o site (webview) ou o arquivo (FileViewer).
 *
 * Estado das abas vem do PreviewProvider (App). Aqui fica só o que é da tela:
 * modo Selecionar, voltar/avançar disponíveis e recarregar.
 */
import { useEffect, useRef, useState } from 'react'
import { isWebUrl, type InspectorPick, type PreviewTab } from '@shared/preview'
import { fileUrl } from '../fileUrl'
import { usePreviewState } from './PreviewContext'
import { PreviewTabStrip, PreviewToolbar } from './PreviewChrome'
import { WebPreview, type NavState, type WebControls, type WebHooks } from './WebPreview'
import { FilePreview } from './FilePreview'
import { normalizeTarget } from './previewTabs'
import './preview.css'

// Soltar arquivo: quem trata é o RightPaneDrop, que cobre o painel da direita
// inteiro (qualquer aba). Aqui não há camada própria.

function EmptyState(): JSX.Element {
  return (
    <div className="pp-empty">
      <strong>Nada aberto no Preview</strong>
      <p>
        Cole um link ou o caminho de um arquivo na barra acima, clique num link da conversa ou arraste um arquivo para
        cá. Com Selecionar, aponte um trecho para mandar ao agente.
      </p>
      <ul>
        <li>Sites e páginas HTML</li>
        <li>Markdown já formatado, planilhas do Excel e CSV em tabela, apresentações do PowerPoint</li>
        <li>Código, JSON e texto com cores</li>
        <li>Imagens, PDF, vídeo e áudio</li>
      </ul>
    </div>
  )
}

export function PreviewPane(): JSX.Element {
  const st = usePreviewState()
  const [picking, setPicking] = useState(false)
  const [nav, setNav] = useState<NavState>({ canBack: false, canForward: false })
  const [reloadKey, setReloadKey] = useState(0)
  const controlRef = useRef<WebControls | null>(null)
  const addressRef = useRef<HTMLInputElement>(null)

  const tab: PreviewTab | null = st?.tabs.find((t) => t.id === st.activeId) ?? null
  const tabId = tab?.id ?? null

  // Trocou de aba: seleção desligada e histórico do zero.
  useEffect(() => {
    setPicking(false)
    setNav({ canBack: false, canForward: false })
  }, [tabId])

  if (!st) {
    return (
      <div className="pp-root">
        <div className="pp-notice" role="alert">
          <p>O Preview não está disponível nesta janela.</p>
        </div>
      </div>
    )
  }

  const hooks: WebHooks = {
    picking,
    onPickingChange: setPicking,
    onPick: (p: InspectorPick) => {
      if (!tab) return
      st.pick(tab, p)
      setPicking(false)
    },
    onNavigate: (url: string) => {
      if (tab) st.navigateTab(tab.id, url)
    },
    onTitle: (title: string) => {
      if (tab && (tab.kind === 'web' || tab.kind === 'html')) st.setTitle(tab.id, title)
    },
    onNavState: setNav,
    controlRef,
    tabId: tab?.id
  }

  const submit = (raw: string): boolean => {
    const target = normalizeTarget(raw, st.cwd)
    if (!target) return false
    if (tab) st.navigateTab(tab.id, target)
    else st.openInPreview(target, { reveal: false })
    return true
  }

  const reload = (): void => {
    if (!tab) return
    // Site: recarrega a própria página. Arquivo: lê de novo do disco.
    if (tab.kind === 'web') controlRef.current?.reload()
    else setReloadKey((k) => k + 1)
  }

  const openOutside = (): void => {
    if (tab) window.open(isWebUrl(tab.target) ? tab.target : fileUrl(tab.target), '_blank')
  }

  const newTab = (): void => {
    st.selectTab(null)
    // Espera o campo esvaziar e põe o cursor nele.
    requestAnimationFrame(() => addressRef.current?.focus())
  }

  return (
    <div className="pp-root">
      <PreviewTabStrip tabs={st.tabs} activeId={st.activeId} onSelect={st.selectTab} onClose={st.closeTab} onNew={newTab} />
      <PreviewToolbar
        tab={tab}
        canBack={nav.canBack}
        canForward={nav.canForward}
        onBack={() => controlRef.current?.back()}
        onForward={() => controlRef.current?.forward()}
        onReload={reload}
        canPick={!!tab}
        picking={picking}
        onPickingChange={setPicking}
        onSubmit={submit}
        onOpenOutside={openOutside}
        addressRef={addressRef}
      />
      <div className="pp-stage">
        {!tab ? (
          <EmptyState />
        ) : tab.kind === 'web' ? (
          <WebPreview key={tab.id} src={tab.target} followNav {...hooks} />
        ) : (
          <FilePreview key={tab.id} tab={tab} reloadKey={reloadKey} {...hooks} />
        )}
      </div>
    </div>
  )
}
