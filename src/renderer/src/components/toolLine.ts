/**
 * Rótulo e alvo de uma ação no grupo de passos ABERTO do chat — PURO. A linha
 * mono do mockup (docs/spec/chat-visual-20261007): "busca setShirtColor ✓ 14",
 * "leu office3d/agentBody.ts ✓ 146 l", "bash git show --stat ✓". Só o chat usa
 * (ToolCard com `check`); a Central e o cartão solto seguem com o describeTool.
 */
import { describeTool } from './toolDescribe'

const KIND: Record<string, string> = {
  Grep: 'busca',
  Glob: 'busca',
  Read: 'leu',
  Edit: 'editou',
  MultiEdit: 'editou',
  NotebookEdit: 'editou',
  Write: 'escreveu',
  Bash: 'bash',
  PowerShell: 'shell',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'agente',
  Agent: 'agente',
  Skill: 'skill'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** O tipo curto da ação (busca, leu, bash…); MCP e o resto: o nome sem o prefixo, em minúsculas. */
export function toolKind(name: string): string {
  return KIND[name] ?? name.replace(/^mcp__[^_]+__/, '').toLowerCase()
}

/** O caminho curto: a pasta de cima e o arquivo ("office3d/agentBody.ts"). */
export function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.slice(-2).join('/') || p
}

/** O alvo: padrão da busca, caminho curto, 1ª linha do comando, URL, consulta, descrição. */
export function toolTarget(name: string, input: unknown): string {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  switch (name) {
    case 'Grep':
    case 'Glob':
      return str(inp.pattern)
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write': {
      const p = str(inp.file_path)
      return p ? shortPath(p) : ''
    }
    case 'NotebookEdit': {
      const p = str(inp.notebook_path)
      return p ? shortPath(p) : ''
    }
    case 'Bash':
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
