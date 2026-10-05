/**
 * O cartão de ferramenta no celular, com os rótulos do desktop (toolDescribe.ts —
 * fonte única do ToolCard do PC e do Escritório): recolhido numa linha com verbo,
 * detalhe, +N −M e a pílula; o toque abre a entrada legível e o resultado. Um
 * entregável criado por Write ganha "Baixar" (pela ponte nativa do APK).
 */
import { useState } from 'react'
import { CodeBlock } from '@renderer/components/CodeBlock'
import { describeTool, TOOL_CODE_MAX, TOOL_RESULT_MAX, toolBadge, toolErrored, toolInputView, writtenPath } from '@renderer/components/toolDescribe'
import { client } from '../app/runtime'
import { triggerDownload } from '../core/download'
import type { ToolUseMsg } from '../core/types'
import { Icon } from '../ui/icons'

export function ToolCard({ m }: { m: ToolUseMsg }): JSX.Element {
  const [open, setOpen] = useState(false)
  const info = describeTool(m.name, m.input)
  const hasDiff = !!info.stats && (info.stats.added > 0 || info.stats.removed > 0)
  const badge = toolBadge(m.name, m.result)
  const filePath = m.result && !m.result.isError ? writtenPath(m.name, m.input) : ''
  const view = open ? toolInputView(m.name, m.input) : null
  return (
    <div className={`tool-card${info.isSkill ? ' tool-skill' : ''}${toolErrored(m.name, m.result) ? ' tool-error' : ''}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-caret">{open ? '▾' : '▸'}</span>
        <span className="tool-name">{info.verb}</span>
        {info.detail && <span className="tool-detail">{info.detail}</span>}
        {hasDiff && info.stats && (
          <span className="tool-diff">
            {info.stats.added > 0 && <span className="diff-add">+{info.stats.added}</span>}
            {info.stats.removed > 0 && <span className="diff-del">−{info.stats.removed}</span>}
          </span>
        )}
        {filePath && (
          <span
            className="tool-download"
            role="button"
            onClick={(e) => {
              e.stopPropagation()
              triggerDownload(client.fileUrl(filePath), filePath)
            }}
          >
            <Icon name="download" size={14} /> Baixar
          </span>
        )}
        <span className={`tool-badge ${badge.kind}`}>{badge.text}</span>
      </button>
      {view && (
        <div className="tool-body">
          {view.caption && <div className="tool-caption">{view.caption}</div>}
          {view.code ? <CodeBlock code={view.code.slice(0, TOOL_CODE_MAX)} language={view.language} /> : <div className="tool-empty">(sem conteúdo)</div>}
          {m.result && (
            <>
              <div className="tool-section-label">resultado</div>
              <pre className={`tool-result-pre${m.result.isError ? ' err' : ''}`}>{m.result.text.slice(0, TOOL_RESULT_MAX)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}
