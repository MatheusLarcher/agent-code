/**
 * Bloco de código das respostas (```...```): uma barra em cima com a linguagem
 * e o botão "Copiar", como no Claude. A barra fica fora da área que rola do
 * <pre>, então o botão não some quando o código é largo. Usado pelo Markdown
 * no app e no celular (o mesmo componente).
 */
import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import type { ExtraProps } from 'react-markdown'
import { IconCheck, IconCopy } from './Icons'
import './codeFrame.css'

interface HastLike {
  type: string
  tagName?: string
  value?: string
  properties?: { className?: unknown }
  children?: HastLike[]
}

const textOf = (node: HastLike | undefined): string => {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

/** O código do bloco, sem a quebra de linha final que o Markdown acrescenta. */
export function codeText(node: HastLike | undefined): string {
  return textOf(node).replace(/\r?\n$/, '')
}

/** "language-ts" do <code> → "ts" (vazio quando o bloco não diz a linguagem). */
export function codeLanguage(node: HastLike | undefined): string {
  const code = node?.children?.find((c) => c.type === 'element' && c.tagName === 'code')
  const cls = code?.properties?.className
  const list = Array.isArray(cls) ? cls.map(String) : typeof cls === 'string' ? cls.split(/\s+/) : []
  const lang = list.find((c) => c.startsWith('language-'))
  return lang ? lang.slice('language-'.length) : ''
}

/** Copia texto; sem a API moderna (página fora de contexto seguro), cai no execCommand. */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* tenta o caminho antigo abaixo */
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

type CopyState = 'idle' | 'done' | 'fail'

export function CopyCodeButton({ text }: { text: string }): JSX.Element {
  const [state, setState] = useState<CopyState>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async (): Promise<void> => {
    const ok = await copyToClipboard(text)
    setState(ok ? 'done' : 'fail')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1800)
  }
  const label = state === 'done' ? 'Copiado' : state === 'fail' ? 'Não copiou' : 'Copiar'
  return (
    <button
      type="button"
      className={`md-code-copy${state === 'idle' ? '' : ` ${state}`}`}
      aria-label={state === 'idle' ? 'Copiar código' : label}
      // Não rouba o foco do campo de mensagem.
      onMouseDown={(e) => e.preventDefault()}
      onClick={copy}
    >
      {state === 'done' ? <IconCheck size={13} /> : <IconCopy size={13} />}
      <span>{label}</span>
    </button>
  )
}

type PreProps = ExtraProps & HTMLAttributes<HTMLPreElement> & { children?: ReactNode }

/** O <pre> do Markdown com a barra de linguagem + Copiar. */
export function CodeFrame({ node, children, ...rest }: PreProps): JSX.Element {
  const hast = node as unknown as HastLike | undefined
  const text = codeText(hast)
  const lang = codeLanguage(hast)
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || 'código'}</span>
        <CopyCodeButton text={text} />
      </div>
      <pre {...rest}>{children}</pre>
    </div>
  )
}
