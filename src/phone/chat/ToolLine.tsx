/**
 * Uma ação dentro do passo aberto, no chat do celular (o visual de
 * docs/spec/chat-visual-20261007): UMA linha mono — o tipo colorido (busca, bash,
 * leu…), o alvo e o "✓ N" verde colado ao texto, sem caixa nem pílula "done". O
 * toque abre ali a entrada e o resultado (o mesmo corpo do ToolCard). A Central e o
 * Escritório seguem com o ToolCard em cartão.
 */
import { useState } from 'react'
import { describeTool, toolErrored, writtenPath } from '@renderer/components/toolDescribe'
import { client } from '../app/runtime'
import { triggerDownload } from '../core/download'
import type { ToolUseMsg } from '../core/types'
import { Icon } from '../ui/icons'
import { ToolBody } from './ToolCard'

const KIND: Record<string, string> = {
  Grep: 'busca',
  Glob: 'busca',
  Read: 'leu',
  Edit: 'editou',
  MultiEdit: 'editou',
  NotebookEdit: 'editou',
  Write: 'criou',
  Bash: 'bash',
  PowerShell: 'shell',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'agente',
  Agent: 'agente',
  Skill: 'skill',
  AskUserQuestion: 'pergunta'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** O tipo curto da ação (busca, leu, bash…); MCP e o resto: o nome sem o prefixo. */
export function toolKind(name: string): string {
  return KIND[name] ?? name.replace(/^mcp__[^_]+__/, '').toLowerCase()
}

/** O alvo: padrão da busca, arquivo, comando, URL… (o detalhe do toolDescribe quando ele tem). */
export function toolTarget(name: string, input: unknown): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  switch (name) {
    case 'Grep':
    case 'Glob':
      return str(inp.pattern)
    case 'PowerShell':
      return str(inp.command).trim().split('\n')[0]
    case 'WebFetch':
      return str(inp.url)
    case 'WebSearch':
      return str(inp.query)
    case 'Task':
    case 'Agent':
      return str(inp.description)
    default:
      return describeTool(name, input).detail
  }
}

/** O número depois do ✓: achados da busca, linhas lidas, +N −M da edição; '' = só o ✓. */
export function toolCount(m: ToolUseMsg): string {
  const text = m.result?.text ?? ''
  const lines = text.split('\n').filter((l) => l.trim()).length
  switch (m.name) {
    case 'Grep': {
      const found = /^Found (\d+)/.exec(text.trim())
      return found ? found[1] : lines ? String(lines) : ''
    }
    case 'Glob':
      return lines ? String(lines) : ''
    case 'Read':
      return lines ? `${lines} l` : ''
    default: {
      const s = describeTool(m.name, m.input).stats
      if (!s || (!s.added && !s.removed)) return ''
      return [s.added ? `+${s.added}` : '', s.removed ? `−${s.removed}` : ''].filter(Boolean).join(' ')
    }
  }
}

export function ToolLine({ m }: { m: ToolUseMsg }): JSX.Element {
  const [open, setOpen] = useState(false)
  const target = toolTarget(m.name, m.input)
  const failed = toolErrored(m.name, m.result)
  const count = m.result && !failed ? toolCount(m) : ''
  const filePath = m.result && !m.result.isError ? writtenPath(m.name, m.input) : ''
  return (
    <div className={`tool-line${open ? ' open' : ''}`}>
      <button type="button" className="tl-row" aria-expanded={open} title={target || m.name} onClick={() => setOpen((o) => !o)}>
        <span className="tl-k">{toolKind(m.name)}</span>
        {target && <span className="tl-t">{target}</span>}
        {!m.result ? (
          <span className="tl-run">…</span>
        ) : failed ? (
          <span className="tl-err">✗</span>
        ) : (
          <span className="tl-ok">{count ? `✓ ${count}` : '✓'}</span>
        )}
        {filePath && (
          <span
            className="tl-dl"
            role="button"
            aria-label="Baixar"
            onClick={(e) => {
              e.stopPropagation()
              triggerDownload(client.fileUrl(filePath), filePath)
            }}
          >
            <Icon name="download" size={13} />
          </span>
        )}
      </button>
      {open && <ToolBody m={m} />}
    </div>
  )
}
