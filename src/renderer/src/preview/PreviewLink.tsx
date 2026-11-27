/**
 * Link do Markdown do chat que abre no Preview: http(s) e caminhos locais
 * (file:, C:\…) vão para a aba Preview do painel da direita.
 *
 * Sem Preview (testes, janelas soltas) ou com Ctrl/Shift/clique do meio, o
 * link segue como sempre: target=_blank, que o main manda para o navegador.
 *
 * Dentro de um .md aberto no próprio Preview, link relativo (`./b.md`) vale a
 * partir da pasta do arquivo: o MarkdownView põe essa pasta em
 * `<PreviewLinkBase>`.
 */
import { createContext, useContext, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from 'react'
import { defaultUrlTransform } from 'react-markdown'
import { usePreview } from './PreviewContext'

/** Caminho com letra de unidade (C:\… ou C:/…). */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/

/** Barras e contrabarras, também as escritas em %2F / %5C. */
function slashes(s: string): string {
  return s.replace(/%2f|%5c/gi, '/').replace(/\\/g, '/')
}

/**
 * Endereço que leva a outra máquina pela rede (SMB): \\servidor\…, //servidor/…
 * (sob a base file:// do app vira file://servidor), file://servidor/… e
 * file:////servidor/…. Abrir ou só carregar um desses manda as credenciais do
 * Windows (NTLM) para o servidor.
 */
function isRemote(url: string): boolean {
  const s = slashes(url.trim())
  if (s.startsWith('//')) return true
  if (!/^file:/i.test(s)) return false
  let rest = s.slice(5)
  if (rest.startsWith('//')) {
    const m = /^\/\/([^/?#]*)([\s\S]*)$/.exec(rest)
    const host = m?.[1] ?? ''
    rest = m?.[2] ?? ''
    if (host && !/^localhost$/i.test(host) && !/^[A-Za-z]:$/.test(host)) return true
  }
  return rest.startsWith('//')
}

/**
 * O react-markdown apaga, por segurança, todo esquema fora de http/https/mailto…
 * — inclusive file: e "C:\…", que o Preview sabe abrir. Mantém esses dois a
 * mais só no `href` dos links (no `src` de imagem, carregar file: sozinho é o
 * mesmo risco); o resto (javascript: etc.) segue pelo filtro padrão. Endereço
 * de outra máquina (\\servidor, file://servidor) é recusado sempre.
 */
export function previewUrlTransform(url: string, key?: string): string {
  if (isRemote(url)) return ''
  const isLink = key === undefined || key === 'href'
  if (isLink && (/^file:/i.test(url) || DRIVE_PATH.test(url))) return url
  return defaultUrlTransform(url)
}

/** Pasta do arquivo .md aberto no Preview (base dos links relativos). */
const PreviewLinkBaseContext = createContext<string | null>(null)

export function PreviewLinkBase({ dir, children }: { dir: string | null; children: ReactNode }): JSX.Element {
  return <PreviewLinkBaseContext.Provider value={dir}>{children}</PreviewLinkBaseContext.Provider>
}

type Props = ComponentPropsWithoutRef<'a'> & { node?: unknown }

export function PreviewLink({ node: _node, onClick, ...props }: Props): JSX.Element {
  const pv = usePreview()
  const base = useContext(PreviewLinkBaseContext)
  const handle = (e: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(e)
    if (e.defaultPrevented || !pv || !props.href) return
    // Ctrl/⌘/Shift ou outro botão: o usuário quer o navegador de fora.
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
    const opened = base ? pv.openInPreview(props.href, { base }) : pv.openInPreview(props.href)
    if (opened) e.preventDefault()
  }
  return <a {...props} target="_blank" rel="noreferrer" onClick={handle} />
}
