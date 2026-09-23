/**
 * No chat da Tela de Planejamento, todo arquivo que o Agent Manager cria vira
 * um link clicável logo abaixo da ferramenta que o criou — o usuário não
 * precisa caçar o caminho no texto.
 *
 * Quais contam: `Write` bem-sucedido (código de teste no _sandbox) e o handoff
 * gravado por `plan_handoff_write`. Os cards não: eles já estão no canvas.
 *
 * Abrir = VS Code (`openInEditor`), nunca o programa padrão do sistema: o
 * arquivo foi escrito pelo agente, e "abrir" um .bat/.exe no Windows é
 * executá-lo. Só vale caminho DENTRO da pasta do plano (docs/spec/<slug>/),
 * sem `..` e sem os caracteres que o shell do `code "<path>"` interpretaria.
 */
import type { MouseEvent } from 'react'
import { IconFile } from '../components/Icons'
import { useUI } from '../ui/UiProvider'

export const HANDOFF_TOOL = 'mcp__planning__plan_handoff_write'
const HANDOFF_RESULT = /Handoff gravado em (.+?)\s*$/

function norm(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** `path` é um arquivo dentro de `planDir` que dá para abrir com segurança? */
export function isInsidePlan(path: string, planDir: string): boolean {
  if (!path || !planDir || /["%\r\n`]/.test(path)) return false
  const file = norm(path)
  const root = norm(planDir)
  if (!file.startsWith(`${root}/`)) return false
  return !file.slice(root.length + 1).split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
}

/** O arquivo que esta chamada de ferramenta criou na pasta do plano, ou null. */
export function createdPlanFile(
  name: string,
  input: unknown,
  result: { text: string; isError?: boolean } | undefined,
  planDir: string | undefined
): string | null {
  if (!planDir || !result || result.isError) return null
  let path = ''
  if (name === 'Write') {
    const p = (input && typeof input === 'object' ? (input as Record<string, unknown>).file_path : '') ?? ''
    path = typeof p === 'string' ? p : ''
  } else if (name === HANDOFF_TOOL) {
    path = HANDOFF_RESULT.exec(result.text.trim())?.[1] ?? ''
  }
  return path && isInsidePlan(path, planDir) ? path : null
}

export function PlanFileLink({ path }: { path: string }): JSX.Element {
  const { notify } = useUI()
  const name = path.split(/[\\/]/).pop() || path
  const open = async (e: MouseEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    const r = await window.api.openInEditor(path)
    if (!r.ok) notify('erro', r.message)
  }
  return (
    <a className="pl-file-link" href="#" onClick={(e) => void open(e)} title={`Abrir no VS Code: ${path}`}>
      <span className="pl-file-link-icon" aria-hidden="true">
        <IconFile size={13} />
      </span>
      <span className="pl-file-link-name">{name}</span>
      <span className="pl-file-link-cta">Abrir</span>
    </a>
  )
}
