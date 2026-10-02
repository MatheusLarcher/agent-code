/**
 * Tela focada do monitor no modo 3D: o cartão de ferramenta do chat aberto
 * (mesmas classes .tool-card/.tool-head/.tool-body e o mesmo CodeBlock), com
 * cabeçalho fixo (ferramenta, arquivo, +/−, status) e corpo rolável.
 *
 * Acompanha o feed (o pai re-renderiza a cada feed) e, no principal, o código
 * ao vivo do liveInput — assinado só enquanto esta tela existe.
 */
import { useEffect, useState } from 'react'
import { CodeBlock } from '../components/CodeBlock'
import { currentTool } from '../components/office/screenContent'
import type { LookupInfo } from '../office/adapter/director'
import type { OfficeFeed } from '../office/adapter/feed'
import { liveInput, type ToolInputDelta } from '../office/liveInput'
import { liveView, toolView } from './toolView'

export interface ToolScreenProps {
  feed: OfficeFeed | null
  info: LookupInfo | undefined
  onOpenFile: (path: string) => void
}

const STATUS: Record<'run' | 'ok' | 'live', { cls: string; text: string }> = {
  run: { cls: 'run', text: 'running…' },
  ok: { cls: 'ok', text: 'done' },
  live: { cls: 'run', text: 'ao vivo' }
}

export function ToolScreen({ feed, info, onOpenFile }: ToolScreenProps): JSX.Element {
  const convId = info?.convId ?? null
  const isMain = !!info && !info.trackId
  const [live, setLive] = useState<ToolInputDelta | undefined>(() => (isMain && convId ? liveInput.latest(convId, null) : undefined))

  useEffect(() => {
    if (!isMain || !convId) return
    setLive(liveInput.latest(convId, null))
    return liveInput.subscribe(convId, null, (ev) => setLive(ev.done ? undefined : ev))
  }, [isMain, convId])

  // Barato; o realce (caro) já é memoizado pelo CodeBlock por código+linguagem.
  const view = live ? liveView(live) : toolView(currentTool(feed, info))
  const status = view.status === 'none' ? null : STATUS[view.status]

  return (
    <div className="o3d-tool" data-testid="office-screen" data-kind={view.kind}>
      <div className="tool-card o3d-tool-card">
        <div className="tool-head o3d-tool-head">
          <span className="tool-name">{view.verb}</span>
          {view.detail &&
            (view.path ? (
              <button type="button" className="tool-detail o3d-tool-path" title={view.path} onClick={() => onOpenFile(view.path)}>
                {view.detail}
              </button>
            ) : (
              <span className="tool-detail">{view.detail}</span>
            ))}
          {view.stats && (view.stats.added > 0 || view.stats.removed > 0) && (
            <span className="tool-diff">
              {view.stats.added > 0 && <span className="diff-add">+{view.stats.added}</span>}
              {view.stats.removed > 0 && <span className="diff-del">−{view.stats.removed}</span>}
            </span>
          )}
          {status && <span className={`tool-badge ${status.cls}`}>{status.text}</span>}
        </div>
        <div className="tool-body o3d-tool-body">
          {view.kind === 'empty' ? (
            <div className="tool-empty">Sem ferramenta em uso.</div>
          ) : (
            <>
              {view.caption && <div className="tool-caption">{view.caption}</div>}
              {view.code ? <CodeBlock code={view.code} language={view.language || undefined} /> : null}
              {view.result && (
                <>
                  <div className="tool-section-label">resultado</div>
                  <pre className="tool-result-pre">{view.result}</pre>
                </>
              )}
              {!view.code && !view.result && <div className="tool-empty">(sem conteúdo)</div>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
