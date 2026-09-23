import { useMemo, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PlanningCardType } from '@shared/ipc'
import { refHrefTipo, refsToMarkdownLinks, splitRefs, type RefCard } from '../planning/cardRefs'
import { CARD_TYPE_LABEL, typeColorVar } from '../planning/cardTypes'

/** Rótulo de [[...]] → card do plano (null = não é um card: fica como texto). */
export type CardRefResolver = (label: string) => RefCard | null

// Links must open in the system browser, not navigate the app frame. Forcing
// target=_blank routes the click through the main process' window-open handler
// (shell.openExternal), so the Electron renderer never navigates away.
const mdComponents = {
  a: (props: ComponentPropsWithoutRef<'a'>) => <a {...props} target="_blank" rel="noreferrer" />
}

/** [[Nome]] que resolveu: o nome com a cor do tipo do card (a mesma do canvas). */
export function CardRefChip({ tipo, children }: { tipo: string; children: ReactNode }): JSX.Element {
  const known = Object.prototype.hasOwnProperty.call(CARD_TYPE_LABEL, tipo) ? (tipo as PlanningCardType) : 'nota'
  return (
    <span
      className="pl-card-ref"
      data-tipo={known}
      title={CARD_TYPE_LABEL[known]}
      style={{ '--pl-ref': typeColorVar(known) } as CSSProperties}
    >
      {children}
    </span>
  )
}

// Com referências: o link '#card-ref/<tipo>/<id>' (refsToMarkdownLinks) vira a
// pílula colorida — não é link, não navega. Os outros links seguem como acima.
const mdComponentsWithRefs = {
  a: (props: ComponentPropsWithoutRef<'a'>) => {
    const tipo = refHrefTipo(props.href)
    return tipo ? <CardRefChip tipo={tipo}>{props.children}</CardRefChip> : mdComponents.a(props)
  }
}

/** Render text as GitHub-flavored Markdown (headings, lists, code, tables, …).
 *  Safe: react-markdown builds React nodes, no raw HTML. Shared by the chat
 *  (assistant answers) and the file preview (.md "Janela de Arquivo").
 *  `resolveRef` (só o chat do Agent Manager): [[Nome]] de um card vira a pílula
 *  com a cor do tipo; sem ele, o texto sai exatamente como sempre. */
export function Markdown({ text, resolveRef }: { text: string; resolveRef?: CardRefResolver | null }): JSX.Element {
  const source = useMemo(() => (resolveRef ? refsToMarkdownLinks(text, resolveRef) : text), [text, resolveRef])
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={resolveRef ? mdComponentsWithRefs : mdComponents}>
        {source}
      </ReactMarkdown>
    </div>
  )
}

/** Texto puro (a mensagem do usuário) com [[Nome]] de card destacado como no Markdown. */
export function CardRefText({ text, resolveRef }: { text: string; resolveRef: CardRefResolver }): JSX.Element {
  return (
    <>
      {splitRefs(text, resolveRef).map((part, i) =>
        typeof part === 'string' ? (
          part
        ) : (
          <CardRefChip key={i} tipo={part.card.tipo}>
            {part.label}
          </CardRefChip>
        )
      )}
    </>
  )
}
