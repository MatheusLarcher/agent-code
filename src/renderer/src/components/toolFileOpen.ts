/**
 * Abrir o arquivo de um cartão de ferramenta num editor ao lado — opcional: só
 * o painel Chat do monitor do Escritório fornece (o editor fica à esquerda
 * dele). Sem o contexto (a aba Conversa), o ToolCard é o de sempre.
 *
 * Contam as ferramentas de arquivo: Read, NotebookRead, Write, Edit, MultiEdit
 * e NotebookEdit (os mesmos conjuntos do app Código do monitor).
 */
import { createContext, useContext } from 'react'
import type { UIMessage } from '../types'

type ToolUse = Extract<UIMessage, { kind: 'tool-use' }>

export interface ToolFileOpen {
  /** Abre o arquivo do cartão no editor (quem fornece decide como e avisa se não der). */
  open: (m: ToolUse) => void
}

export const ToolFileOpenContext = createContext<ToolFileOpen | null>(null)

export function useToolFileOpen(): ToolFileOpen | null {
  return useContext(ToolFileOpenContext)
}

/** As ferramentas cujo cartão abre o arquivo no editor. */
export const FILE_TOOLS: ReadonlySet<string> = new Set(['Read', 'NotebookRead', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/** O caminho do arquivo do cartão ('' se não for ferramenta de arquivo ou não tiver caminho). */
export function toolFilePath(m: Pick<ToolUse, 'name' | 'input'>): string {
  if (!FILE_TOOLS.has(m.name)) return ''
  const inp = (m.input ?? {}) as Record<string, unknown>
  const p = typeof inp.file_path === 'string' ? inp.file_path : typeof inp.notebook_path === 'string' ? inp.notebook_path : ''
  return p.trim()
}
