/**
 * O cartão de ferramenta do chat (Claude-Code-style): recolhido, uma linha com
 * ▸, o verbo, o detalhe, o +N −M de edição, Preview/Baixar quando houver e a
 * pílula (running… / done / error); clicar abre a entrada legível (CodeBlock) e
 * o resultado. Os rótulos vêm de toolDescribe.ts — a mesma fonte que o
 * Escritório 3D usa nos monitores e nas telas.
 *
 * Com quem abra arquivos num editor ao lado (toolFileOpen.ts — só o Chat do
 * monitor do Escritório), o cartão de arquivo se divide: a ▸ é um botão que só
 * expande, e o resto do cabeçalho abre o arquivo ("Abrir no editor"). Sem ele,
 * o cartão é o de sempre.
 */
import { useState, type MouseEvent } from 'react'
import { isTextPreviewable } from '@shared/ipc'
import { fileUrl } from '../fileUrl'
import type { UIMessage } from '../types'
import { useUI } from '../ui/UiProvider'
import { CodeBlock } from './CodeBlock'
import { describeTool, TOOL_CODE_MAX, TOOL_RESULT_MAX, toolBadge, toolErrored, toolInputView, writtenPath } from './toolDescribe'
import { toolFilePath, useToolFileOpen } from './toolFileOpen'

export type ToolUseMessage = Extract<UIMessage, { kind: 'tool-use' }>

export function ToolCard({ m }: { m: ToolUseMessage }): JSX.Element {
  const [open, setOpen] = useState(false)
  const { notify } = useUI()
  const opener = useToolFileOpen()
  const openable = !!opener && toolFilePath(m) !== ''
  const info = describeTool(m.name, m.input)
  const hasDiff = info.stats && (info.stats.added > 0 || info.stats.removed > 0)
  const errored = toolErrored(m.name, m.result)
  const badge = toolBadge(m.name, m.result)
  // Offer a download once the write succeeded (the file exists on disk).
  const filePath = m.result && !m.result.isError ? writtenPath(m.name, m.input) : ''

  let rawFilePath = ''
  if (m.name === 'Write' && m.input && typeof m.input === 'object') {
    const p = (m.input as Record<string, unknown>).file_path
    if (typeof p === 'string' && p) rawFilePath = p
  }

  const download = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation()
    const r = await window.api.downloadFile(filePath)
    notify(r.ok ? 'sucesso' : 'erro', r.message)
  }

  const preview = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!rawFilePath) return
    try {
      const res = await window.api.newTab('file', fileUrl(rawFilePath))
      if (res && res !== 'sucesso' && !res.toLowerCase().includes('abrindo') && !res.toLowerCase().includes('aberta')) {
        notify('erro', res)
      }
    } catch (err) {
      notify('erro', `Falha ao abrir preview: ${String(err)}`)
    }
  }

  const head = (
    <>
      <span className="tool-name">{info.verb}</span>
      {info.detail && <span className="tool-detail">{info.detail}</span>}
      {hasDiff && info.stats && (
        <span className="tool-diff">
          {info.stats.added > 0 && <span className="diff-add">+{info.stats.added}</span>}
          {info.stats.removed > 0 && <span className="diff-del">−{info.stats.removed}</span>}
        </span>
      )}
      {rawFilePath && isTextPreviewable(rawFilePath) && m.result && !m.result.isError && (
        <span className="tool-download" onClick={preview} title="Abrir em uma Janela de Arquivo">
          Preview
        </span>
      )}
      {filePath && (
        <span className="tool-download" onClick={download} title="Baixar arquivo">
          ⬇️ Baixar
        </span>
      )}
      <span className={`tool-badge ${badge.kind}`}>{badge.text}</span>
    </>
  )

  return (
    <div className={`tool-card ${info.isSkill ? 'tool-skill' : ''} ${errored ? 'tool-error' : ''}${openable ? ' tool-file' : ''}`}>
      {openable && opener ? (
        <div className="tool-head tool-head-split">
          <button type="button" className="tool-caret-btn" aria-expanded={open} aria-label="Mostrar a entrada e o resultado" title="Mostrar a entrada e o resultado" onClick={() => setOpen((o) => !o)}>
            <span className="tool-caret">{open ? '▾' : '▸'}</span>
          </button>
          <button type="button" className="tool-open" title="Abrir no editor" onClick={() => opener.open(m)}>
            {head}
            <svg className="tool-go" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 17 17 7M9 7h8v8" />
            </svg>
          </button>
        </div>
      ) : (
        <button className="tool-head" onClick={() => setOpen((o) => !o)}>
          <span className="tool-caret">{open ? '▾' : '▸'}</span>
          {head}
        </button>
      )}
      {open && (() => {
        const view = toolInputView(m.name, m.input)
        return (
          <div className="tool-body">
            {view.caption && <div className="tool-caption">{view.caption}</div>}
            {view.code ? (
              <CodeBlock code={view.code.slice(0, TOOL_CODE_MAX)} language={view.language} />
            ) : (
              <div className="tool-empty">(sem conteúdo)</div>
            )}
            {m.result && (
              <>
                <div className="tool-section-label">resultado</div>
                <pre className="tool-result-pre">{m.result.text.slice(0, TOOL_RESULT_MAX)}</pre>
              </>
            )}
          </div>
        )
      })()}
    </div>
  )
}
