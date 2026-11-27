/**
 * Uma aba de arquivo local: pede o conteúdo ao main (previewReadFile) e decide
 * onde mostrar — html e mídia vão para o <webview> pela URL agent-preview://;
 * markdown, planilha, json, código e texto vão para o FileViewer.
 * Cada falha (não achou, pasta protegida, grande demais…) vira um aviso claro.
 */
import { useEffect, useState } from 'react'
import type { PreviewFileOk, PreviewFileResult, PreviewTab } from '@shared/preview'
import { FileViewer } from './viewers/FileViewer'
import { WebPreview, type WebHooks } from './WebPreview'
import { failureText } from './inspector'
import { FilePickHost } from './filePicker/FilePickHost'

type ReadFile = (path: string) => Promise<PreviewFileResult>

/** O preload ainda pode não ter a função (versão antiga do app): sem ela, aviso em vez de quebrar. */
function readFileApi(): ReadFile | null {
  const api = (window as unknown as { api?: { previewReadFile?: ReadFile } }).api
  return typeof api?.previewReadFile === 'function' ? api.previewReadFile.bind(api) : null
}

type Load =
  | { state: 'loading' }
  | { state: 'ok'; result: PreviewFileOk }
  | { state: 'fail'; title: string; text: string }

interface Props extends WebHooks {
  tab: PreviewTab
  /** Muda quando o usuário pede para recarregar: lê o arquivo de novo. */
  reloadKey: number
}

export function FilePreview({ tab, reloadKey, ...hooks }: Props): JSX.Element {
  const [load, setLoad] = useState<Load>({ state: 'loading' })

  useEffect(() => {
    let alive = true
    const read = readFileApi()
    if (!read) {
      setLoad({ state: 'fail', ...failureText('no-api') })
      return
    }
    setLoad({ state: 'loading' })
    read(tab.target)
      .then((r) => {
        if (!alive) return
        if (r.ok) setLoad({ state: 'ok', result: r })
        else setLoad({ state: 'fail', ...failureText(r.reason, r.message) })
      })
      .catch((err: unknown) => {
        if (alive) setLoad({ state: 'fail', ...failureText('error', err instanceof Error ? err.message : String(err)) })
      })
    return () => {
      alive = false
    }
  }, [tab.target, reloadKey])

  if (load.state === 'loading') {
    return (
      <div className="pp-notice" role="status">
        <span className="pp-spin" aria-hidden="true" />
        <p>Abrindo {tab.title}…</p>
      </div>
    )
  }
  if (load.state === 'fail') {
    return (
      <div className="pp-notice" role="alert">
        <strong>{load.title}</strong>
        <p>{load.text}</p>
        <code className="pp-path">{tab.target}</code>
      </div>
    )
  }
  const r = load.result
  if (r.kind === 'html' || r.kind === 'media') {
    return <WebPreview key={`${r.url}#${reloadKey}`} src={r.url} followNav={false} {...hooks} />
  }
  return (
    <FilePickHost
      picking={hooks.picking}
      onPickingChange={hooks.onPickingChange}
      onPick={hooks.onPick}
      url={tab.target}
      tabId={hooks.tabId}
    >
      <FileViewer result={r} />
    </FilePickHost>
  )
}
