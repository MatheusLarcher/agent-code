/**
 * A Prévia do HTML do Agent no app Código: uma aba "Prévia: x.html" por
 * arquivo, logo depois da aba do código dele, com a página no lugar do editor
 * (PreviewPane). É estado de interface — não vem das mensagens: as prévias
 * abertas e a que está à vista.
 *
 *   abrir     o olho da faixa de abas (o .html à vista), o cartão do Write/Edit
 *             de um .html no Chat (chatOpen.ts) ou o clique no agente que acabou
 *             de criar um (freshHtmlWrite, quando a tela monta)
 *   seguir    quem abre também abre a aba do código (code.open/onBrowse), o que
 *             deixa de seguir o Agent; voltar a seguir sai da prévia
 *   limite    no máximo MAX_TABS prévias: abrir mais uma tira a mais antiga
 *
 * Cada escrita do arquivo que deu certo recarrega a página: `lastWriteOf` dá o
 * id da última (muda a cada Write/Edit).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { baseName } from '../../components/toolDescribe'
import type { HtmlWrite } from '../agentHtml'
import { MAX_TABS } from './codeModel'
import type { TabItem } from './parts'
import { normalizePath } from './pathGuard'
import type { CodeAppState } from './useCodeApp'

/** O prefixo da chave da aba da Prévia na faixa (a do arquivo é o caminho normalizado). */
export const PAGE_TAB = 'pv:'

export interface PageTab {
  /** A chave do arquivo (normalizePath), a mesma da aba do código. */
  key: string
  path: string
  name: string
}

/** As abas da faixa com a Prévia de cada arquivo logo depois da aba do código dele (sem ela, no fim). */
export function withPageTabs(items: readonly TabItem[], pages: readonly PageTab[]): readonly TabItem[] {
  if (pages.length === 0) return items
  const tab = (p: PageTab): TabItem => ({ key: PAGE_TAB + p.key, path: p.path, name: p.name, status: null, typing: false, page: true })
  const out: TabItem[] = []
  for (const t of items) {
    out.push(t)
    const p = pages.find((x) => x.key === t.key)
    if (p) out.push(tab(p))
  }
  for (const p of pages) if (!items.some((t) => t.key === p.key)) out.push(tab(p))
  return out
}

/** O id da última escrita que deu certo do arquivo (as escritas vêm da mais recente para a mais antiga). */
export function lastWriteOf(writes: readonly HtmlWrite[], key: string): string | null {
  return writes.find((w) => w.ok && normalizePath(w.path) === key)?.id ?? null
}

export interface HtmlPreview {
  pages: readonly PageTab[]
  /** A Prévia à vista (null: o código). */
  active: PageTab | null
  /** Abre (ou só ativa) a Prévia do arquivo — quem chama já abriu a aba do código (openInEditor). */
  open: (path: string) => void
  /** Para o CodeView (estáveis): escolher um arquivo (aba, Explorador, árvore) sai da Prévia; a aba da Prévia e o olho a mostram, sem seguir o Agent. */
  onSelect: (key: string) => void
  onBrowse: (path: string) => void
  onSelectPage: (key: string) => void
  onOpenPage: (path: string) => void
}

/** `code.follow`: o app Código está seguindo o Agent — a Prévia sai da vista. */
export function useHtmlPreview(code: Pick<CodeAppState, 'follow' | 'onSelect' | 'onBrowse'>): HtmlPreview {
  const { follow, onSelect: select, onBrowse: browse } = code
  const [pages, setPages] = useState<PageTab[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const open = useCallback((path: string) => {
    const key = normalizePath(path)
    setPages((list) => (list.some((p) => p.key === key) ? list : [...list, { key, path, name: baseName(path) }].slice(-MAX_TABS)))
    setActiveKey(key)
  }, [])
  const onSelect = useCallback((key: string) => {
    setActiveKey(null)
    select(key)
  }, [select])
  const onBrowse = useCallback((path: string) => {
    setActiveKey(null)
    browse(path)
  }, [browse])
  const onSelectPage = useCallback((key: string) => {
    select(key)
    setActiveKey(key)
  }, [select])
  const onOpenPage = useCallback((path: string) => {
    select(normalizePath(path))
    open(path)
  }, [select, open])
  // Voltar a seguir o Agent sai da Prévia: a tela mostra o arquivo que ele está mexendo.
  useEffect(() => {
    if (follow) setActiveKey(null)
  }, [follow])
  const active = (!follow && pages.find((p) => p.key === activeKey)) || null
  return useMemo(
    () => ({ pages, active, open, onSelect, onBrowse, onSelectPage, onOpenPage }),
    [pages, active, open, onSelect, onBrowse, onSelectPage, onOpenPage]
  )
}
